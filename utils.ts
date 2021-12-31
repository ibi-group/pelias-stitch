import { URLSearchParams } from 'url'

import fetch from 'node-fetch'
import { getDistance } from 'geolib'
import { fromCoordinates } from '@conveyal/lonlat'
import type { LonLatOutput } from '@conveyal/lonlat'
import type { Feature, FeatureCollection, Position } from 'geojson'
import bugsnag from '@bugsnag/js'
import type {
  AutocompleteQuery,
  SearchQuery,
  ReverseQuery
} from '@opentripplanner/geocoder'

// Types
export type ServerlessEvent = {
  headers: Record<string, string>
  queryStringParameters: Record<string, string>
}
export type ServerlessCallbackFunction = (
  error: string | null,
  response: {
    body: string
    headers: Record<string, string>
    statusCode: number
  } | null
) => void
export type ServerlessResponse = {
  body: string
  headers: Record<string, string>
  statusCode: number
}

/**
 * This method removes all characters Pelias doesn't support.
 * Unfortunately, these characters not only don't match if they're found in the
 * elasticsearch record, but make the query fail and return no results.
 * Therefore, they are removed using this method. The search still completes
 * as one would expect: "ab @ c" gets converted to "ab  c" which still matches
 * an item named "ab @ c"
 * @param queryString The *URL decoded* string with invalid characters to be cleaned
 * @returns           The string with invalid characters replaced
 */
export const makeQueryPeliasCompatible = (queryString: string): string => {
  return queryString.replace(/@/g, ' ').replace(/&/g, ' ')
}

/**
 * This method converts Query String Parameters from AWS into an object
 * which can be passed into a geocoder from @otp-ui/geocoder.
 * @param queryStringParams The query string parameters from the event object
 * @returns           The object with the valid geocoder query.
 */
export const convertQSPToGeocoderArgs = (
  queryStringParams: Record<string, string>
): AutocompleteQuery & SearchQuery & ReverseQuery => {
  const params = new URLSearchParams(queryStringParams)
  const geocoderArgs: AutocompleteQuery & SearchQuery & ReverseQuery = {}

  const [minLat, minLon, maxLat, maxLon, size] = [
    params.get('boundary.rect.min_lat'),
    params.get('boundary.rect.min_lon'),
    params.get('boundary.rect.max_lat'),
    params.get('boundary.rect.max_lon'),
    params.get('size')
  ].map((p) => p && parseInt(p))

  const text = params.get('text')

  if (minLat && minLon && maxLat && maxLon) {
    geocoderArgs.boundary = {
      rect: { maxLat, maxLon, minLat, minLon }
    }
  }
  if (params.get('focus.point.lat')) {
    geocoderArgs.focusPoint = {
      lat: params.get('focus.point.lat'),
      lon: params.get('focus.point.lon')
    }
  }
  if (params.get('point.lat')) {
    geocoderArgs.point = {
      lat: params.get('point.lat'),
      lon: params.get('point.lon')
    }
  }
  if (text) {
    geocoderArgs.text = text
  }
  if (size) {
    geocoderArgs.size = size
  }

  return geocoderArgs
}

/**
 * Executes a request on a Pelias instance
 * This is used for 'manually' querying a Pelias instance outside outside of the geocoder package.
 * @param baseUrl URL of the Pelias instance, without a trailing slash
 * @param service The endpoint to make the query to (generally search or autocomplete)
 * @param query   The rest of the Pelias query (any GET paremeters)
 * @returns       Pelias response decoded from JSON
 */
export const fetchPelias = async (
  baseUrl: string,
  service: string,
  query: string
): Promise<FeatureCollection> => {
  try {
    const response = await fetch(`${baseUrl}/${service}?${query}`, {})
    return await response.json()
  } catch (e) {
    bugsnag.notify(e)
    console.warn(`${baseUrl} failed to return valid Pelias response`)
    return { features: [], type: 'FeatureCollection' }
  }
}

/**
 * Compares two GeoJSON positions and returns if they are equal within 10m accuracy
 * @param a One GeoJSON Position object
 * @param b One GeoJSON Position Object
 * @returns True if the positions describe the same place, false if they are different
 */
export const arePointsRoughlyEqual = (a: Position, b: Position): boolean => {
  // 4 decimal places is approximately 10 meters, which is acceptable error
  const aRounded = a.map((point: number): number =>
    parseFloat(point.toFixed(4))
  )
  const bRounded = b.map((point: number): number =>
    parseFloat(point.toFixed(4))
  )

  return aRounded.every((element, index) => element === bRounded[index])
}

/**
 * Inspects a feature and removes it if a similar feature is included within a
 * second list of features
 * @param feature The feature to either keep or remove
 * @param customFeatures The set of features to check against
 * @returns True or false depending on if the feature is unique
 */
const filterOutDuplicateStops = (
  feature: Feature,
  customFeatures: Feature[]
): boolean => {
  // If the feature to be tested isn't a stop, we don't have to check it.
  // In OpenStreetMap, some transit stops have an "operator" tag which is
  // added to the addendum field in Pelias. Therefore, there is still potential
  // for some transit stops without the "operator" tag to still be included in
  // search results.
  if (
    !feature.properties ||
    !feature.properties.addendum ||
    // if a OSM feature has an operator tag, it is a transit stop
    ((!feature.properties.addendum.osm ||
      !feature.properties.addendum.osm.operator) &&
      // HERE public transport categories start with a 400
      !feature.properties.addendum.categories?.find(
        (c) => !!c.id.match(/^400-/)
      ))
  ) {
    // Returning true ensures the Feature is *saved*
    return true
  }

  // If a custom feature at the same location *can't* be found, return the Feature
  return !customFeatures.find((otherFeature: Feature) => {
    // Check Point data exists before working with it
    if (
      feature.geometry.type !== 'Point' ||
      otherFeature.geometry.type !== 'Point'
    ) {
      return null
    }

    // If this is true, we have a match! Which will be negated above to remove the
    // duplicate
    return arePointsRoughlyEqual(
      feature.geometry.coordinates,
      otherFeature.geometry.coordinates
    )
  })
}

/**
 * Merges two Pelias responses together
 * @param responses An object containing two Pelias response objects
 * @returns         A single Pelias response object the features from both input objects
 */
export const mergeResponses = (
  responses: {
    customResponse: FeatureCollection
    primaryResponse: FeatureCollection
  },
  focusPoint?: LonLatOutput
): FeatureCollection => {
  // Openstreetmap can sometimes include bus stop info with less
  // correct information than the GTFS feed.
  // Remove anything from the geocode.earth response that's within 10 meters of a custom result
  responses.primaryResponse.features =
    responses.primaryResponse.features.filter((feature: Feature) =>
      filterOutDuplicateStops(feature, responses.customResponse.features)
    )

  // If a focus point is specified, sort custom features by distance to the focus point
  // This ensures the 3 stops are all relevant.
  if (focusPoint) {
    responses.customResponse.features.sort((a, b) => {
      if (
        a &&
        a.geometry.type === 'Point' &&
        b &&
        b.geometry.type === 'Point'
      ) {
        // Use lonlat to convert GeoJSON Point to input geolib can handle
        // Compare distances between coordiante and focus point
        return (
          getDistance(fromCoordinates(a.geometry.coordinates), focusPoint) -
          getDistance(fromCoordinates(b.geometry.coordinates), focusPoint)
        )
      }
      // Can't do a comparison, becuase types are wrong
      return 0
    })
  }

  // Merge features together
  const mergedFeatures: Array<Feature> = [
    ...responses.customResponse.features,
    ...responses.primaryResponse.features
  ]

  // Insert merged features back into Geocode.Earth response
  const mergedResponse: FeatureCollection = {
    ...responses.primaryResponse
  }
  mergedResponse.features = mergedFeatures

  return mergedResponse
}
