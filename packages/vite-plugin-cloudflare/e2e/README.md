# vite-plugin e2e tests

This directory contains e2e test that give more confidence that the plugin will work in real world scenarios outside the comfort of this monorepo.

In general, these tests create test projects by copying a fixture from the `fixtures` directory into a temporary directory and then installing the local builds of the plugin along with its dependencies.

## Running the tests

Simply use turbo to run the tests from the root of the monorepo.
This will also ensure that the required dependencies have all been built before running the tests.

```sh
pnpm test:e2e -F @cloudflare/vite-plugin
```

## Developing e2e tests

These tests use a mock npm registry where the built plugin has been published.

The registry is booted up and loaded with the local build of the plugin and its local dependencies in the global-setup.ts file that runs once at the start of the e2e test run, and the server is killed and its caches removed at the end of the test run.

The Vite `test` function is an extended with additional helpers to setup clean copies of fixtures outside of the monorepo so that they can be isolated from any other dependencies in the project.

The simplest test looks like:

```ts
test("can serve a Worker request", async ({ expect, seed, viteDev }) => {
	const projectPath = await seed("basic", "pnpm");

	const proc = await viteDev(projectPath);
	const url = await waitForReady(proc);
	expect(await fetchJson(url + "/api/")).toEqual({ name: "Cloudflare" });
});
```

- The `seed()` helper does the following:
  - makes a copy of the named fixture into a temporary directory,
  - updates the vite-plugin dependency in the package.json to match the local version
  - runs `npm install` (or equivalent package manager command) in the temporary project
  - returns the path to the directory containing the copy (`projectPath` above)
  - the temporary directory will be deleted at the end of the test.
- The `runCommand()` helper simply executes a one-shot command and resolves when it has exited. You can use this to install the dependencies of the fixture from the mock npm registry.
- The `viteDev()` helper boots up the `vite dev` command and returns an object that can be used to monitor its output. The process will be killed at the end of the test.
- The `waitForReady()` helper will resolve when the `vite dev` process has output its ready message, from which it will parse the url that can be fetched in the test.
- The `fetchJson()` helper makes an Undici fetch to the url parsing the response into JSON. It will retry every 250ms for up to 10 secs to minimize flakes.

## Debugging the tests

You can provide the following environment variables to get access to the logs and the actual files being tested:

- `NODE_DEBUG=vite-plugin:test` - this will display debugging log messages as well as the streamed output from the commands being run.
- `CLOUDFLARE_VITE_E2E_KEEP_TEMP_DIRS=1` - this will prevent the temporary directory containing the test project from being deleted, so that you can go and play with it manually.
