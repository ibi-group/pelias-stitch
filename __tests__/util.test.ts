import { FeatureCollection } from 'geojson'

import {
  arePointsRoughlyEqual,
  checkIfResultsAreSatisfactory,
  makeQueryPeliasCompatible,
  mergeResponses
} from '../utils'

// This is not a real mock, so can be imported using require()
// eslint-disable-next-line jest/no-mocks-import
const CUSTOM_RESPONSE =
  require('./json-mocks/custom-response.json') as FeatureCollection
const GEOCODE_EARTH_RESPONSE =
  require('./json-mocks/geocode-earth-response.json') as FeatureCollection
const GEOCODE_EARTH_RESPONSE_BUS =
  require('./json-mocks/geocode-earth-response-bus.json') as FeatureCollection
const GEOCODE_EARTH_RESPONSE_BUS_SAME_NAME =
  require('./json-mocks/geocode-earth-response-bus-same-name.json') as FeatureCollection
const HERE_RESPONSE_BUS =
  require('./json-mocks/here-response-bus.json') as FeatureCollection

describe('arePointsEqual', () => {
  it('should treat 2 identical coordinates as identical', () => {
    expect(arePointsRoughlyEqual([5, 5], [5, 5])).toBe(true)
    expect(arePointsRoughlyEqual([5.000000000001, 5], [5.0, 5])).toBe(true)
    expect(arePointsRoughlyEqual([5.123456, 5.7], [5.123458, 5.7])).toBe(true)
    expect(arePointsRoughlyEqual([5.12346, 5.7], [5.12348, 5.7])).toBe(true)
    // Rounding test
    expect(arePointsRoughlyEqual([9.12345666, 5.7], [9.12348444, 5.7])).toBe(
      true
    )
  })
  it('should treat 2 different coordinates as different', () => {
    expect(arePointsRoughlyEqual([7, 5], [5, 5])).toBe(false)
    // Rounding test
    expect(arePointsRoughlyEqual([5.1233, 5.7], [5.1234, 5.7])).toBe(false)
    expect(arePointsRoughlyEqual([5.12342, 5.7], [5.12348, 5.7])).toBe(false)
    expect(arePointsRoughlyEqual([9.12342666, 5.7], [9.12348444, 5.7])).toBe(
      false
    )
  })
})

describe('pelias string cleaning', () => {
  it('should strip pelias-unfriendly characters from a string correctly', () => {
    const badString =
      'first street @ second street & third street @ fourth & fifth'
    expect(makeQueryPeliasCompatible(badString)).toMatchSnapshot()
  })
})

describe('response merging', () => {
  it('should merge 2 real responses correctly', () => {
    const merged = mergeResponses({
      customResponse: CUSTOM_RESPONSE,
      primaryResponse: GEOCODE_EARTH_RESPONSE
    })
    expect(merged).toBeDefined()
    expect(merged).toMatchSnapshot()

    // This is done to test that merging is done idempotently
    // This is a common issue when dealing with Javascript objects
    // We don't want to affect the original responses
    const mergedAgain = mergeResponses({
      customResponse: CUSTOM_RESPONSE,
      primaryResponse: GEOCODE_EARTH_RESPONSE
    })
    expect(mergedAgain).toBeDefined()
    expect(mergedAgain).toMatchSnapshot()
  })

  it('should not filter out 2 identical responses if geocodeEarth response is not a bus stop', () => {
    const merged = mergeResponses({
      customResponse: GEOCODE_EARTH_RESPONSE_BUS,
      primaryResponse: GEOCODE_EARTH_RESPONSE
    })
    expect(merged).toMatchSnapshot()
  })
  it('should filter out 2 identical responses if geocodeEarth response is a bus stop', () => {
    const merged = mergeResponses({
      customResponse: GEOCODE_EARTH_RESPONSE,
      primaryResponse: GEOCODE_EARTH_RESPONSE_BUS
    })
    expect(merged).toMatchSnapshot()
  })
  it('should filter out 2 identical responses if geocodeEarth response has the same name', () => {
    const merged = mergeResponses({
      customResponse: GEOCODE_EARTH_RESPONSE,
      primaryResponse: GEOCODE_EARTH_RESPONSE_BUS_SAME_NAME
    })
    expect(merged).toMatchSnapshot()
  })
  it('should filter out 2 identical responses if HERE response is a bus stop', () => {
    const merged = mergeResponses({
      customResponse: GEOCODE_EARTH_RESPONSE,
      primaryResponse: HERE_RESPONSE_BUS
    })
    expect(merged).toMatchSnapshot()
  })
  it('should sort results depending on focus point', () => {
    const mergedFocusedOnBusStop = mergeResponses(
      {
        customResponse: CUSTOM_RESPONSE,
        primaryResponse: GEOCODE_EARTH_RESPONSE
      },
      { lat: 47.880281, lon: -122.238459 }
    )
    const mergedFocusedOnSteinerStreet = mergeResponses(
      {
        customResponse: CUSTOM_RESPONSE,
        primaryResponse: GEOCODE_EARTH_RESPONSE
      },
      { lat: 37.793899, lon: -122.43634 }
    )
    expect(mergedFocusedOnBusStop).not.toEqual(mergedFocusedOnSteinerStreet)
    expect(mergedFocusedOnBusStop).toMatchSnapshot()
    expect(mergedFocusedOnSteinerStreet).toMatchSnapshot()
  })
})

describe('response rejection', () => {
  it('should reject an empty response', () => {
    const response = checkIfResultsAreSatisfactory(
      { features: [], type: 'FeatureCollection' },
      ''
    )
    expect(response).toBe(false)
  })
  it('should reject a response with all incorrect layers', () => {
    const response = checkIfResultsAreSatisfactory(
      {
        features: [
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'country', name: 'search' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'disputed', name: 'search' } }
        ],
        type: 'FeatureCollection'
      },
      'search'
    )

    expect(response).toBe(false)
  })

  it('should accept a response with one correct layer and many incorrect layers', () => {
    const response = checkIfResultsAreSatisfactory(
      {
        features: [
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'country', name: 'search' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'venue', name: 'search' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'disputed', name: 'search' } }
        ],
        type: 'FeatureCollection'
      },
      'search'
    )

    expect(response).toBe(true)
  })
  it('should accept a response with all correct layers and correct name', () => {
    const response = checkIfResultsAreSatisfactory(
      {
        features: [
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'address', name: 'search' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'venue', name: 'search' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'street', name: 'search' } }
        ],
        type: 'FeatureCollection'
      },
      'search'
    )

    expect(response).toBe(true)
  })
  it('should reject a response with correct layers, but no name', () => {
    const response = checkIfResultsAreSatisfactory(
      {
        features: [
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'address' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'venue' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'street' } }
        ],
        type: 'FeatureCollection'
      },
      'search'
    )

    expect(response).toBe(false)
  })
  it('should reject a response with correct layers, but incorrect name', () => {
    const response = checkIfResultsAreSatisfactory(
      {
        features: [
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'address', name: 'something different' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'venue', name: 'not the s word' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'street', name: 'bearch' } }
        ],
        type: 'FeatureCollection'
      },
      'search'
    )

    expect(response).toBe(false)

    // These failure cases are contreversial, but are in line with the philosophy to
    // proactively fail rather than pass
    const evenCloserResponse = checkIfResultsAreSatisfactory(
      {
        features: [
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'address', name: 'searchQuery' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'venue', name: 'searc uery' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'street', name: 'searc' } }
        ],
        type: 'FeatureCollection'
      },
      'search query'
    )
    expect(evenCloserResponse).toBe(false)
  })
  it('should reject a response with incorrect layers, but correct name', () => {
    const response = checkIfResultsAreSatisfactory(
      {
        features: [
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'region', name: 'something different' } },
          // @ts-expect-error demonstration object missing some data
          { properties: { layer: 'dependency', name: 'not the s word' } },
          // @ts-expect-error demonstration object missing some data
          {
            properties: {
              layer: 'localadmin',
              name: 'look what we found it is the search'
            }
          }
        ],
        type: 'FeatureCollection'
      },
      'search'
    )

    expect(response).toBe(false)
  })
})
