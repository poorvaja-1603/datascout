# DataScout web app

This React/Vite SPA implements the contract-backed search, result history, source status, evidence/detail, and comparison flows. It never renders source text as HTML. `UNKNOWN` verification is presented as `PARTIAL` so unavailable evidence is not shown as a confirmed pass or fail.

## Run locally

Install dependencies in this directory, copy `.env.example` to `.env`, and run `npm run dev`. In demo mode, start the contract mock server from the repository root with `npm run mock`; the default frontend API URL points to its port 4010. The mock API accepts the `mock-access-token` token selected by the local demo-auth switch.

For Cognito, set `VITE_DEMO_MODE=false`, the hosted UI domain and public SPA client ID, and make the local frontend origin an allowed callback and sign-out URL in the app client. The flow uses Authorization Code with PKCE and stores the access token locally for API calls. Configure the API URL to the deployed API Gateway origin/stage. These `VITE_` values are public browser configuration; never put client secrets or API credentials in them.

The app currently targets the v1 contract routes: `/search`, `/results/{request_id}`, `/dataset/{dataset_id}`, and `/compare`. The search result layout is responsive and supports keyboard-operable native controls, partial-source warnings, clarification/refusal states, and bounded dataset comparison selection.
