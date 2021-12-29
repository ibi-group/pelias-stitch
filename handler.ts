/**
 * This script contains the AWS Lambda handler code for merging two Pelias instances
 * together.
 * Dependencies are listed in package.json in the same folder.
 * Notes:
 * - Most of the folder contents is uploaded to AWS Lambda (see README.md for deploying).
 */

import { URLSearchParams } from 'url'

import Bugsnag from '@bugsnag/js'
import type { FeatureCollection } from 'geojson'

import {
  ServerlessEvent,
  ServerlessCallbackFunction,
  ServerlessResponse,
  fetchHere,
  fetchPelias,
  makeQueryPeliasCompatible,
  mergeResponses
} from './utils'

// This plugin must be imported via cjs to ensure its existence (typescript recommendation)
const BugsnagPluginAwsLambda = require('@bugsnag/plugin-aws-lambda')
const {
  BUGSNAG_NOTIFIER_KEY,
  CSV_ENABLED,
  CUSTOM_PELIAS_URL,
  GEOCODE_EARTH_API_KEY,
  GEOCODE_EARTH_URL,
  GEOCODER,
  HERE_API_KEY
} = process.env

// Ensure env variables have been set
if (
  typeof CUSTOM_PELIAS_URL !== 'string' ||
  typeof GEOCODE_EARTH_API_KEY !== 'string' ||
  typeof GEOCODE_EARTH_URL !== 'string' ||
  typeof BUGSNAG_NOTIFIER_KEY !== 'string'
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

/**
 * Makes a call to a Pelias Instance using secrets from the config file.
 * Includes special query parameters needed for each type of server.
 *
 * Errors will automatically be caught by the bugsnag wrapper on the handler
 * @param event Event from Serverless framework
 * @param apiMethod Method to call on Pelias Server
 * @returns Object containing Serverless response object including parsed JSON responses from both Pelias instances
 */
export const makePeliasRequests = async (
  event: ServerlessEvent,
  apiMethod: string
): Promise<ServerlessResponse> => {
  // "Clean" the text parameter to ensure the user's query is understood by Pelias
  if (event?.queryStringParameters?.text) {
    event.queryStringParameters.text = makeQueryPeliasCompatible(
      event.queryStringParameters.text
    )
  }
  // Query parameters are returned in a strange format, so have to be converted
  // to URL parameters before being converted to a string
  const query = new URLSearchParams(event.queryStringParameters).toString()

  // Select which primary geocoder to use.
  const primaryGeocoder =
    GEOCODER === 'HERE'
      ? fetchHere(apiMethod, event.queryStringParameters, HERE_API_KEY)
      : fetchPelias(
          GEOCODE_EARTH_URL,
          apiMethod,
          query + `&api_key=${GEOCODE_EARTH_API_KEY}`
        )

  // Run both requests in parallel
  const [primaryResponse, customResponse]: [
    FeatureCollection,
    FeatureCollection
  ] = await Promise.all([
    primaryGeocoder,
    // Should the custom Pelias instance need to be replaced with something different
    // this is where it should be replaced
    fetchPelias(
      CUSTOM_PELIAS_URL,
      apiMethod,
      `${query}&sources=transit${CSV_ENABLED ? ',pelias' : ''}`
    )
  ])

  const mergedResponse = mergeResponses({
    customResponse,
    primaryResponse
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
    const response = await makePeliasRequests(event, 'autocomplete')

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
    const response = await makePeliasRequests(event, 'search')

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
    const query = new URLSearchParams(event.queryStringParameters).toString()
    const geocoderResponse =
      GEOCODER === 'HERE'
        ? await fetchHere('reverse', event.queryStringParameters, HERE_API_KEY)
        : await fetchPelias(
            GEOCODE_EARTH_URL,
            'reverse',
            query + `&api_key=${GEOCODE_EARTH_API_KEY}`
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
