/**
 * This script contains the AWS Lambda handler code for merging two Pelias instances
 * together.
 * Dependencies are listed in package.json in the same folder.
 * Notes:
 * - Most of the folder contents is uploaded to AWS Lambda (see README.md for deploying).
 */
import { URLSearchParams } from 'url'

import Bugsnag from '@bugsnag/js'
import getGeocoder from '@opentripplanner/geocoder'
import { createClient } from 'redis'
import type { FeatureCollection } from 'geojson'

import {
  cachedGeocoderRequest,
  checkIfResultsAreSatisfactory,
  convertQSPToGeocoderArgs,
  fetchPelias,
  makeQueryPeliasCompatible,
  mergeResponses,
  ServerlessCallbackFunction,
  ServerlessEvent,
  ServerlessResponse
} from './utils'

// This plugin must be imported via cjs to ensure its existence (typescript recommendation)
const BugsnagPluginAwsLambda = require('@bugsnag/plugin-aws-lambda')
const {
  BUGSNAG_NOTIFIER_KEY,
  CUSTOM_PELIAS_URL,
  GEOCODE_EARTH_URL,
  GEOCODER,
  GEOCODER_API_KEY,
  REDIS_HOST,
  REDIS_KEY,
  SECONDARY_GEOCODE_EARTH_URL,
  SECONDARY_GEOCODER,
  SECONDARY_GEOCODER_API_KEY,
  TRANSIT_BASE_URL,
  TRANSIT_GEOCODER
} = process.env

const redis = REDIS_HOST
  ? createClient({
      password: REDIS_KEY,
      url: 'redis://' + REDIS_HOST
    })
  : null
if (redis) redis.on('error', (err) => console.log('Redis Client Error', err))

// Ensure env variables have been set
if (
  typeof TRANSIT_GEOCODER !== 'string' ||
  typeof TRANSIT_BASE_URL !== 'string' ||
  typeof GEOCODER_API_KEY !== 'string' ||
  typeof BUGSNAG_NOTIFIER_KEY !== 'string' ||
  typeof GEOCODER !== 'string'
) {
  throw new Error(
    'Error: configuration variables not found! Ensure env.yml has been decrypted'
  )
}

Bugsnag.start({
  apiKey: BUGSNAG_NOTIFIER_KEY,
  appType: 'pelias-stitcher-lambda-function',
  appVersion: require('./package.json').version,
  plugins: [BugsnagPluginAwsLambda],
  releaseStage: process.env.STAGE
})
// This handler will wrap around the handler code
// and will report exceptions to Bugsnag automatically.
// For reference, see https://docs.bugsnag.com/platforms/javascript/aws-lambda/#usage
const bugsnagHandler = Bugsnag.getPlugin('awsLambda').createHandler()

const getPrimaryGeocoder = () => {
  if (GEOCODER === 'PELIAS' && typeof GEOCODE_EARTH_URL !== 'string') {
    throw new Error('Error: Geocode earth URL not set.')
  }
  return getGeocoder({
    apiKey: GEOCODER_API_KEY,
    baseUrl: GEOCODE_EARTH_URL,
    reverseUseFeatureCollection: true,
    type: GEOCODER
  })
}

const getTransitGeocoder = () => {
  return getGeocoder({
    baseUrl: TRANSIT_BASE_URL,
    type: TRANSIT_GEOCODER
  })
}

const getSecondaryGeocoder = () => {
  if (!SECONDARY_GEOCODER || !SECONDARY_GEOCODER_API_KEY) {
    console.warn('Not using secondary Geocoder')
    return false
  }

  if (
    SECONDARY_GEOCODER === 'PELIAS' &&
    typeof SECONDARY_GEOCODE_EARTH_URL !== 'string'
  ) {
    throw new Error(
      'Secondary geocoder configured incorrectly: Geocode.earth URL not set.'
    )
  }
  return getGeocoder({
    apiKey: SECONDARY_GEOCODER_API_KEY,
    baseUrl: SECONDARY_GEOCODE_EARTH_URL,
    reverseUseFeatureCollection: true,
    type: SECONDARY_GEOCODER
  })
}

/**
 * Makes a call to a Pelias Instance using secrets from the config file.
 * Includes special query parameters needed for each type of server.
 *
 * Errors will automatically be caught by the bugsnag wrapper on the handler
 * @param event Event from Serverless framework
 * @param apiMethod Method to call on Pelias Server
 * @returns Object containing Serverless response object including parsed JSON responses from both Pelias instances
 */
export const makeGeocoderRequests = async (
  event: ServerlessEvent,
  apiMethod: string
): Promise<ServerlessResponse> => {
  // "Clean" the text parameter to ensure the user's query is understood by Pelias
  if (event?.queryStringParameters?.text) {
    event.queryStringParameters.text = makeQueryPeliasCompatible(
      event.queryStringParameters.text
    )
  }

  // Pelias has different layers, and so needs to ignore the layers parameter
  // if it is present
  const peliasQSP = { ...event.queryStringParameters }
  delete peliasQSP.layers

  // Run both requests in parallel
  let [primaryResponse, transitResponse, customResponse]: [
    FeatureCollection,
    FeatureCollection,
    FeatureCollection
  ] = await Promise.all([
    cachedGeocoderRequest(
      getPrimaryGeocoder(),
      apiMethod,
      convertQSPToGeocoderArgs(event.queryStringParameters),
      // @ts-expect-error Redis Typescript types are not friendly
      redis
    ),
    cachedGeocoderRequest(
      getTransitGeocoder(),
      'autocomplete',
      convertQSPToGeocoderArgs(event.queryStringParameters),
      // @ts-expect-error Redis Typescript types are not friendly
      redis
    ),
    // Should the custom Pelias instance need to be replaced with something different
    // this is where it should be replaced
    fetchPelias(
      CUSTOM_PELIAS_URL,
      apiMethod,
      `${new URLSearchParams(peliasQSP).toString()}&sources=pelias`
    )
  ])

  // If the primary response doesn't contain responses or the responses are not satisfactory,
  // run a second (non-cached) request with the secondary geocoder, but only if one is configured.
  const secondaryGeocoder = getSecondaryGeocoder()
  if (
    secondaryGeocoder &&
    !checkIfResultsAreSatisfactory(
      primaryResponse,
      event.queryStringParameters.text
    )
  ) {
    console.log('Results not satisfactory, falling back on secondary geocoder')
    primaryResponse = await secondaryGeocoder[apiMethod](
      convertQSPToGeocoderArgs(event.queryStringParameters)
    )
  }

  const mergedResponse = mergeResponses({
    customResponse,
    primaryResponse: mergeResponses({
      customResponse: transitResponse,
      primaryResponse
    })
  })
  return {
    body: JSON.stringify(mergedResponse),
    /*
    The third "standard" CORS header, Access-Control-Allow-Methods is not included here
    following reccomendations in https://www.serverless.com/blog/cors-api-gateway-survival-guide/

    This header is handled within AWS API Gateway, via the serverless CORS setting.
    */
    headers: {
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    },
    statusCode: 200
  }
}

/**
 * Entirely matches the Pelias autocomplete endpoint. Merges 2 autocomplete responses together.
 * See https://github.com/pelias/documentation/blob/master/autocomplete.md
 */
module.exports.autocomplete = bugsnagHandler(
  async (
    event: ServerlessEvent,
    context: null,
    callback: ServerlessCallbackFunction
  ): Promise<void> => {
    if (redis) {
      // Only autocomplete needs redis
      try {
        await redis.connect()
      } catch (e) {
        console.warn('Redis connection failed. Likely already connected')
        console.log(e)
      }
    }

    const response = await makeGeocoderRequests(event, 'autocomplete')

    callback(null, response)
  }
)

/**
 * Entirely matches the Pelias search endpoint. Merges 2 search responses together.
 * See https://github.com/pelias/documentation/blob/master/search.md
 */
module.exports.search = bugsnagHandler(
  async (
    event: ServerlessEvent,
    context: null,
    callback: ServerlessCallbackFunction
  ): Promise<void> => {
    const response = await makeGeocoderRequests(event, 'search')

    callback(null, response)
  }
)

/**
 * Entirely matches the Pelias reverse endpoint. Merges 2 reverse responses together.
 * See https://github.com/pelias/documentation/blob/master/reverse.md
 */
module.exports.reverse = bugsnagHandler(
  async (
    event: ServerlessEvent,
    context: null,
    callback: ServerlessCallbackFunction
  ): Promise<void> => {
    const geocoderResponse = await getPrimaryGeocoder().reverse(
      convertQSPToGeocoderArgs(event.queryStringParameters)
    )

    callback(null, {
      body: JSON.stringify(geocoderResponse),
      /*
        The third "standard" CORS header, Access-Control-Allow-Methods is not included here
        following reccomendations in https://www.serverless.com/blog/cors-api-gateway-survival-guide/

        This header is handled within AWS API Gateway, via the serverless CORS setting.
        */
      headers: {
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      statusCode: 200
    })
  }
)
