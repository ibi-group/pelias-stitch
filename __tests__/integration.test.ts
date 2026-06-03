import { FeatureCollection } from "geojson";

import { checkIfResultsAreSatisfactory, mergeResponses, processAndMergeResponses } from "../utils";

const makeOtpRooseveltResponse = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: [
    {
      geometry: { type: "Point", coordinates: [-122.315976, 47.676595] },
      id: "40:N09",
      properties: {
        layer: "stops",
        source: "otp",
        modes: ["TRAM"],
        name: "Roosevelt",
        label: "Roosevelt (Sound Transit)",
        secondaryLabels: [],
      },
      type: "Feature",
    },
    {
      geometry: { type: "Point", coordinates: [-122.317467, 47.675457] },
      id: "kcm:16440",
      properties: {
        layer: "stops",
        source: "otp",
        modes: ["BUS"],
        name: "Roosevelt Station - Bay 5",
        label: "Roosevelt Station - Bay 5 (Metro Transit 16440)",
        secondaryLabels: ["Roosevelt Station - Bay 5 (Sound Transit)"],
      },
      type: "Feature",
    },
  ],
});

const makePeliasRooseveltResponse = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-77.017027, 38.863066] },
      properties: {
        id: "way/67254524",
        layer: "venue",
        source: "openstreetmap",
        name: "National War College",
        label: "National War College, Washington, DC, USA",
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-87.627439, 41.867708] },
      properties: {
        id: "node/3219617154",
        layer: "venue",
        source: "openstreetmap",
        name: "Roosevelt",
        label: "Roosevelt, Central, Chicago, IL, USA",
        addendum: {
          osm: {
            operator: "Chicago Transit Authority",
          },
        },
      },
    },
  ],
});

const emptyPeliasResponse: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/**
 * Integration tests based on live API behavior from the QA instance.
 * These tests model the real responses from the OTP and Pelias geocoders
 * to identify issues with result filtering and merging.
 *
 * IMPORTANT: mergeResponses MUTATES its input objects (it reassigns
 * primaryResponse.features). We clone the object each time to ensure the
 * tests are independent.
 */
describe("integration: roosevelt search", () => {

  // Make sure all the results are merged together
  it("make sure the merged results include everything", () => {
    const merged = mergeResponses({
      customResponse: makeOtpRooseveltResponse(),
      primaryResponse: makePeliasRooseveltResponse(),
    });

    // has the OTP station
    const rooseveltStation = merged.features.find(
      (f) => f.properties?.name === "Roosevelt" && f.properties?.source === "otp",
    );
    expect(rooseveltStation).toBeDefined();
    expect(rooseveltStation?.properties?.modes).toContain("TRAM");

    const otpResults = merged.features.filter((f) => f.properties?.source === "otp");
    const peliasResults = merged.features.filter((f) => f.properties?.source !== "otp");

    expect(otpResults.length).toBeGreaterThan(0);
    expect(peliasResults.length).toBeGreaterThan(0);
  });
});

describe("integration: gibberish search should return no results", () => {
  /**
   * The OTP geocoder returns results even for gibberish like "rooseveoaifjsoij".
   * None of these results contain the query string in their name.
   * checkIfResultsAreSatisfactory should correctly reject these results,
   * and they should be filtered from final output.
   */

  it("should produce empty results when processing gibberish OTP with empty Pelias (no backup)", async () => {
    /**
     * When OTP returns gibberish and Pelias returns nothing, neither response is
     * satisfactory. With no backup geocoder configured, both should become empty,
     * and the merged result should have 0 features.
     */
    const merged = await processAndMergeResponses({
      uncheckedResponses: [makeOtpRooseveltResponse(), emptyPeliasResponse],
      queryString: "rooseveoaifjsoij",
    });

    expect(merged.features.length).toBe(0);
  });
});

describe("integration: Stadium search should combine OTP and Pelias results", () => {
  const makeOtpStadiumResponse = (): FeatureCollection => ({
    type: "FeatureCollection",
    features: [
      {
        geometry: { type: "Point", coordinates: [-122.327172, 47.591108] },
        id: "40:C13",
        properties: {
          layer: "stops",
          source: "otp",
          modes: ["TRAM"],
          name: "Stadium",
          label: "Stadium (Sound Transit)",
          secondaryLabels: [],
        },
        type: "Feature",
      },
      {
        geometry: { type: "Point", coordinates: [-122.448999, 47.263869] },
        id: "40:T17",
        properties: {
          layer: "stops",
          source: "otp",
          modes: ["TRAM"],
          name: "Stadium District",
          label: "Stadium District (Sound Transit)",
          secondaryLabels: [],
        },
        type: "Feature",
      },
    ],
  });

  const makePeliasStadiumResponse = (): FeatureCollection => ({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-118.167396, 34.160102] },
        properties: {
          id: "way/5208863",
          layer: "venue",
          source: "openstreetmap",
          name: "Rose Bowl Stadium",
          label: "Rose Bowl Stadium, Pasadena, CA, USA",
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-82.349443, 29.648896] },
        properties: {
          id: "way/45719890",
          layer: "venue",
          source: "openstreetmap",
          name: "Ben Hill Griffin Stadium",
          label: "Ben Hill Griffin Stadium, Gainesville, FL, USA",
        },
      },
    ],
  });

  it("should include Pelias venue results with Stadium in the name", () => {
    // There was a bug where Pelias venues with any word that matched a word in an
    // OTP result would get filtered out/deduplicated.
    const merged = mergeResponses({
      customResponse: makeOtpStadiumResponse(),
      primaryResponse: makePeliasStadiumResponse(),
    });

    const peliasStadiums = merged.features.filter(
      (f) =>
        f.properties?.layer === "venue" && f.properties?.name?.toLowerCase().includes("stadium"),
    );
    expect(peliasStadiums.length).toBeGreaterThan(0);

    const stadiumStation = merged.features.find(
      (f) => f.properties?.name === "Stadium" && f.properties?.source === "otp",
    );
    expect(stadiumStation).toBeDefined();
    expect(stadiumStation?.properties?.modes).toContain("TRAM");
  });
});
