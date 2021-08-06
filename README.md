# Pelias Stitcher

This folder contains an AWS lambda script which pretends to be a Pelias endpoint. It will forward any request it receives to both Geocode.earth (using the API key in `env.yml`) and a custom Pelias instance (defined in `env.yml`). It will merge the responses together seamlessly. The client will think it's communicating only with a regular Pelias server.

## Running Locally

Local running is done via the offline serverless plugin. The plugin will automatically build the TypeScript and start a server. Create an `env.yml` file based on the example file provided.

Serverless starts the lambda function server on port `3000`.

The endpoint is then accessible under `http://localhost:3000/dev` (either search or autocomplete)

```bash
yarn start
```

## Test

Testing is done via Jest.

```bash
yarn test
```

will build the TypeScript and run the tests

## Deploy

Ensure the env.yml file is present and contains the keys given in the example file.

Deployment is done via Serverless using AWS keys stored on the computer.

```bash
serverless deploy [--aws-profile [name-of-profile]]
```
