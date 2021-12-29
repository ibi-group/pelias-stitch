import { FeatureCollection } from 'geojson'

import {
  arePointsRoughlyEqual,
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
