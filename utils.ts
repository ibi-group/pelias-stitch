import { URLSearchParams } from 'url'

import bugsnag from '@bugsnag/js'
import { fromCoordinates } from '@conveyal/lonlat'
import { getDistance } from 'geolib'
import fetch from 'node-fetch'
import type { LonLatOutput } from '@conveyal/lonlat'
import type { Feature, FeatureCollection, Position } from 'geojson'
import type { RedisClientType } from 'redis'
import { AnyGeocoderQuery } from '@opentripplanner/geocoder/lib/geocoders/types'

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

// Consts
const PREFERRED_LAYERS = ['venue', 'address', 'street', 'intersection']

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
): AnyGeocoderQuery => {
  const params = new URLSearchParams(queryStringParams)
  const geocoderArgs: AnyGeocoderQuery = {}

  const [minLat, minLon, maxLat, maxLon, size] = [
    params.get('boundary.rect.min_lat'),
    params.get('boundary.rect.min_lon'),
    params.get('boundary.rect.max_lat'),
    params.get('boundary.rect.max_lon'),
    params.get('size')
  ].map((p) => p && parseFloat(p))

  const text = params.get('text')
  const layers = params.get('layers')

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

  // Safe, performant default
  geocoderArgs.size = size || 4
  geocoderArgs.layers = layers || PREFERRED_LAYERS.join(',')

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
  baseUrl?: string,
  service?: string,
  query?: string
): Promise<FeatureCollection> => {
  if (!baseUrl) return { features: [], type: 'FeatureCollection' }
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
  // If the names are the same, or if the feature is too far away, we can't consider the feature
  if (
    customFeatures.find(
      (otherFeature: Feature) =>
        (feature?.properties?.name || '')
          .toLowerCase()
          .includes((otherFeature?.properties?.name || '').toLowerCase()) ||
        // Any feature this far away is likely not worth being considered
        feature?.properties?.distance > 7500
    )
  ) {
    return false
  }

  // If the feature to be tested isn't a stop, we don't have to check its coordinates.
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
    responses?.primaryResponse?.features?.filter((feature: Feature) =>
      filterOutDuplicateStops(feature, responses.customResponse.features)
    ) || []

  // If a focus point is specified, sort custom features by distance to the focus point
  // This ensures the 3 stops are all relevant.
  if (focusPoint && responses.customResponse.features) {
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

  // Insert merged features back into Geocode.Earth response
  const mergedResponse: FeatureCollection = {
    ...responses.primaryResponse,
    features: [
      // Merge features together
      // customResponses may be null, but we know primaryResponse to exist
      ...(responses.customResponse.features || []),
      ...responses.primaryResponse.features
    ]
  }

  return mergedResponse
}

/**
 * Makes a geocoder request by first checking a potential redis store for a cached
 * response. If a response is fetched, stores response in redis store.
 * @param geocoder        geocoder object returned from geocoder package
 * @param requestMethod   Geocoder Request Method
 * @param args            Args for Geocoder request method
 * @param redisClient     Redis client already connected
 * @returns               FeatureCollection either from cache or live
 */
export const cachedGeocoderRequest = async (
  geocoder: Record<string, (q: AnyGeocoderQuery) => Promise<FeatureCollection>>,
  requestMethod: string,
  args: AnyGeocoderQuery,
  redisClient: RedisClientType | null
): Promise<FeatureCollection> => {
  const { focusPoint, text } = args
  if (!text) return { features: [], type: 'FeatureCollection' }
  const redisKey = `${text}:${focusPoint?.lat}:${focusPoint?.lon}`

  if (redisClient) {
    const cachedResponse = await redisClient.get(redisKey)
    if (cachedResponse) {
      return JSON.parse(cachedResponse)
    }
  }
  const onlineResponse = await geocoder[requestMethod](args)
  // If we are at this point and have a redis object we know there
  // was no entry in the cache
  if (redisClient) {
    try {
      redisClient.set(redisKey, JSON.stringify(onlineResponse))
    } catch (e) {
      console.warn(`Could not add response to redis cache: ${e}`)
    }
  }

  return onlineResponse
}

/**
 * Checks if a feature collection provides "satisfactory" results for a given queryString.
 * Satisfactory is defined as having results, having results where at least one is of a set of
 * preferred layers, and as at least one of the results contains the entirety of the query string.
 *
 * This method does two passes over the array for readability -- the temporal difference to doing
 * some form of reducer is minimal.
 *
 * @param featureCollection The GeoJSON featureCollection to check
 * @param queryString       The query string which the featureCollection results are supposed to represent
 * @returns                 true if the results are deemed satisfactory, false otherwise
 */
export const checkIfResultsAreSatisfactory = (
  featureCollection: FeatureCollection,
  queryString: string
): boolean => {
  const { features } = featureCollection

  // Check for zero length
  if (features?.length === 0) return false

  // Check for at least one layer being one of the preferred layers
  if (
    !features?.some((feature) =>
      PREFERRED_LAYERS.includes(feature?.properties?.layer)
    )
  )
    return false

  // Check that the query string is present in at least one returned string
  if (
    !features?.some((feature) =>
      feature?.properties?.name
        ?.toLowerCase()
        .includes(queryString.toLowerCase())
    )
  )
    return false

  return true
}
