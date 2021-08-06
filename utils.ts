import fetch from 'node-fetch'
import { getDistance } from 'geolib'
import { fromCoordinates } from '@conveyal/lonlat'
import type { LonLatOutput } from '@conveyal/lonlat'
import type { Feature, FeatureCollection, Position } from 'geojson'

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
 * Executes a request on a Pelias instance
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
  const response = await fetch(`${baseUrl}/${service}?${query}`, {})
  return await response.json()
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
    !feature.properties.addendum.osm ||
    !feature.properties.addendum.osm.operator
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
    geocodeEarthResponse: FeatureCollection
  },
  focusPoint?: LonLatOutput
): FeatureCollection => {
  // Openstreetmap can sometimes include bus stop info with less
  // correct information than the GTFS feed.
  // Remove anything from the geocode.earth response that's within 10 meters of a custom result
  responses.geocodeEarthResponse.features =
    responses.geocodeEarthResponse.features.filter((feature: Feature) =>
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

  // Only include 3 transit stops at most
  responses.customResponse.features = responses.customResponse.features.slice(
    0,
    // TODO: allow this as a query parameter?
    3
  )

  // Merge features together
  const mergedFeatures: Array<Feature> = [
    ...responses.customResponse.features,
    ...responses.geocodeEarthResponse.features
  ]

  // Insert merged features back into Geocode.Earth response
  const mergedResponse: FeatureCollection = {
    ...responses.geocodeEarthResponse
  }
  mergedResponse.features = mergedFeatures

  return mergedResponse
}
