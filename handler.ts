/**
 * This script contains the AWS Lambda handler code for merging some number of geocoder instances
 * together
 * Dependencies are listed in package.json in the same folder.
 * Notes:
 * - Most of the folder contents is uploaded to AWS Lambda (see README.md for deploying).
 */
import Bugsnag from '@bugsnag/js'
import getGeocoder from '@opentripplanner/geocoder'
import type { FeatureCollection } from 'geojson'
import { OfflineResponse } from '@opentripplanner/geocoder/lib/apis/offline'

import {
  cachedGeocoderRequest,
  checkIfResultsAreSatisfactory,
  convertQSPToGeocoderArgs,
  makeQueryPeliasCompatible,
  mergeResponses,
  ServerlessCallbackFunction,
  ServerlessEvent,
  ServerlessResponse
} from './utils'

// This plugin must be imported via cjs to ensure its existence (typescript recommendation)
const BugsnagPluginAwsLambda = require('@bugsnag/plugin-aws-lambda')
const { BACKUP_GEOCODERS, BUGSNAG_NOTIFIER_KEY, GEOCODERS, POIS } = process.env

if (!GEOCODERS) {
  throw new Error(
    'Error: required configuration variable GEOCODERS not found! Ensure env.yml has been decrypted.'
  )
}
const geocoders = JSON.parse(GEOCODERS)
const backupGeocoders = BACKUP_GEOCODERS && JSON.parse(BACKUP_GEOCODERS)
// Serverless is not great about null
const pois =
  POIS && POIS !== 'null'
    ? (JSON.parse(POIS) as OfflineResponse).map((poi) => {
        if (typeof poi.lat === 'string') {
          poi.lat = parseFloat(poi.lat)
        }
        if (typeof poi.lon === 'string') {
          poi.lon = parseFloat(poi.lon)
        }
        return poi
      })
    : []

if (geocoders.length !== backupGeocoders.length) {
  throw new Error(
    'Error: BACKUP_GEOCODERS is not set to the same length as GEOCODERS'
  )
}

Bugsnag.start({
  apiKey: BUGSNAG_NOTIFIER_KEY || '',
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
  let responses: FeatureCollection[] = await Promise.all(
    geocoders.map((geocoder) =>
      cachedGeocoderRequest(getGeocoder(geocoder), apiMethod, {
        ...convertQSPToGeocoderArgs(event.queryStringParameters),
        items: pois
      })
    )
  )

  responses = await Promise.all(
    responses.map(async (response, index) => {
      // If backup geocoder is present, and the returned results are garbage, use the backup geocoder
      if (
        backupGeocoders[index] &&
        !checkIfResultsAreSatisfactory(
          response,
          event.queryStringParameters.text
        )
      ) {
        const backupGeocoder = getGeocoder(backupGeocoders[index])
        console.log('backup geocoder used!')
        return await backupGeocoder[apiMethod](
          convertQSPToGeocoderArgs(event.queryStringParameters)
        )
      }

      return response
    })
  )

  const merged = responses.reduce((prev, cur, idx) => {
    if (idx === 0) return cur
    // @ts-expect-error Typechecking is broken here for some reason
    if (prev)
      return mergeResponses({ customResponse: cur, primaryResponse: prev })
  }, null)

  return {
    body: JSON.stringify(merged),
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
    let geocoderResponse = await getGeocoder(geocoders[0]).reverse(
      convertQSPToGeocoderArgs(event.queryStringParameters)
    )

    if (!geocoderResponse && backupGeocoders[0]) {
      geocoderResponse = await getGeocoder(backupGeocoders[0]).reverse(
        convertQSPToGeocoderArgs(event.queryStringParameters)
      )
    }

    geocoderResponse.label = geocoderResponse.name

    callback(null, {
      body: JSON.stringify([geocoderResponse]),
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
