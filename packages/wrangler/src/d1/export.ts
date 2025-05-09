import fs from "node:fs/promises";
import path from "node:path";
import { spinner, spinnerWhile } from "@cloudflare/cli/interactive";
import chalk from "chalk";
import { Miniflare } from "miniflare";
import { fetch } from "undici";
import { fetchResult } from "../cfetch";
import { configFileName, readConfig } from "../config";
import { getLocalPersistencePath } from "../dev/get-local-persistence-path";
import { UserError } from "../errors";
import { logger } from "../logger";
import { APIError } from "../parse";
import { readableRelative } from "../paths";
import { requireAuth } from "../user";
import { printWranglerBanner } from "../wrangler-banner";
import { Name } from "./options";
import { getDatabaseByNameOrBinding, getDatabaseInfoFromConfig } from "./utils";
import type { Config } from "../config";
import type {
	CommonYargsArgv,
	StrictYargsOptionsToInterface,
} from "../yargs-types";
import type { Database, ExportPollingResponse, PollingFailure } from "./types";

export function Options(yargs: CommonYargsArgv) {
	return (
		Name(yargs)
			.option("local", {
				type: "boolean",
				describe: "Export from your local DB you use with wrangler dev",
				conflicts: "remote",
			})
			.option("remote", {
				type: "boolean",
				describe: "Export from your live D1",
				conflicts: "local",
			})
			.option("no-schema", {
				type: "boolean",
				describe: "Only output table contents, not the DB schema",
				conflicts: "no-data",
			})
			.option("no-data", {
				type: "boolean",
				describe:
					"Only output table schema, not the contents of the DBs themselves",
				conflicts: "no-schema",
			})
			// For --no-schema and --no-data to work, we need their positive versions
			// to be defined. But keep them hidden as they default to true
			.option("schema", {
				type: "boolean",
				hidden: true,
				default: true,
			})
			.option("data", {
				type: "boolean",
				hidden: true,
				default: true,
			})
			.option("table", {
				type: "string",
				describe: "Specify which tables to include in export",
			})
			.option("output", {
				type: "string",
				describe: "Which .sql file to output to",
				demandOption: true,
			})
	);
}

type HandlerOptions = StrictYargsOptionsToInterface<typeof Options>;
export const Handler = async (args: HandlerOptions): Promise<void> => {
	const { remote, name, output, schema, data, table } = args;
	await printWranglerBanner();
	const config = readConfig(args);

	if (!schema && !data) {
		throw new UserError(`You cannot specify both --no-schema and --no-data`);
	}

	// Allow multiple --table x --table y flags or none
	const tables: string[] = table
		? Array.isArray(table)
			? table
			: [table]
		: [];

	if (remote) {
		return await exportRemotely(config, name, output, tables, !schema, !data);
	} else {
		return await exportLocal(config, name, output, tables, !schema, !data);
	}
};

async function exportLocal(
	config: Config,
	name: string,
	output: string,
	tables: string[],
	noSchema: boolean,
	noData: boolean
) {
	const localDB = getDatabaseInfoFromConfig(config, name);
	if (!localDB) {
		throw new UserError(
			`Couldn't find a D1 DB with the name or binding '${name}' in your ${configFileName(config.configPath)} file.`
		);
	}

	const id = localDB.previewDatabaseUuid ?? localDB.uuid;

	// TODO: should we allow customising persistence path?
	// Should it be --persist-to for consistency (even though this isn't persisting anything)?
	const persistencePath = getLocalPersistencePath(undefined, config);
	const d1Persist = path.join(persistencePath, "v3", "d1");

	logger.log(
		`🌀 Exporting local database ${name} (${id}) from ${readableRelative(
			d1Persist
		)}:`
	);
	logger.log(
		"🌀 To export your remote database, add a --remote flag to your wrangler command."
	);

	const mf = new Miniflare({
		modules: true,
		script: "export default {}",
		d1Persist,
		d1Databases: { DATABASE: id },
	});
	const db = await mf.getD1Database("DATABASE");
	logger.log(`🌀 Exporting SQL to ${output}...`);

	try {
		// Special local-only export pragma. Query must be exactly this string to work.
		const dump = await db
			.prepare(`PRAGMA miniflare_d1_export(?,?,?);`)
			.bind(noSchema, noData, ...tables)
			.raw();
		await fs.writeFile(output, dump[0].join("\n"));
	} catch (e) {
		throw new UserError((e as Error).message);
	} finally {
		await mf.dispose();
	}

	logger.log(`Done!`);
}

async function exportRemotely(
	config: Config,
	name: string,
	output: string,
	tables: string[],
	noSchema: boolean,
	noData: boolean
) {
	const accountId = await requireAuth(config);
	const db: Database = await getDatabaseByNameOrBinding(
		config,
		accountId,
		name
	);

	logger.log(`🌀 Executing on remote database ${name} (${db.uuid}):`);
	const dumpOptions = {
		no_schema: noSchema,
		no_data: noData,
		tables,
	};

	const s = spinner();
	const finalResponse = await spinnerWhile<ExportPollingResponse>({
		spinner: s,
		promise: () => pollExport(s, accountId, db, dumpOptions, undefined),
		startMessage: `Creating export`,
	});

	if (finalResponse.status !== "complete") {
		throw new APIError({ text: `D1 reset before export completed!` });
	}

	logger.log(
		chalk.gray(
			`You can also download your export from the following URL manually. This link will be valid for one hour: ${finalResponse.result.signed_url}`
		)
	);

	await spinnerWhile({
		startMessage: `Downloading SQL to ${output}`,
		async promise() {
			const contents = await fetch(finalResponse.result.signed_url);
			if (!contents.ok) {
				throw new Error(
					`There was an error while downloading from the presigned URL with status code: ${contents.status}`
				);
			}
			await fs.writeFile(output, contents.body || "");
		},
	});
	logger.log(`🌀 Downloaded to ${output} successfully!`);
}

async function pollExport(
	s: ReturnType<typeof spinner>,
	accountId: string,
	db: Database,
	dumpOptions: {
		tables: string[];
		no_schema?: boolean;
		no_data?: boolean;
	},
	currentBookmark: string | undefined,
	num_parts_uploaded = 0
): Promise<ExportPollingResponse> {
	const response = await fetchResult<ExportPollingResponse | PollingFailure>(
		`/accounts/${accountId}/d1/database/${db.uuid}/export`,
		{
			method: "POST",
			headers: {
				...(db.internal_env ? { "x-d1-internal-env": db.internal_env } : {}),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				output_format: "polling",
				dump_options: dumpOptions,
				current_bookmark: currentBookmark,
			}),
		}
	);

	if (!response.success) {
		throw new Error(response.error);
	}

	response.messages.forEach((line) => {
		if (line.startsWith(`Uploaded part`)) {
			// Part numbers can be reported as complete out-of-order which looks confusing to a user. But their ID has no
			// special meaning, so just make them sequential.
			s.update(`Uploaded part ${++num_parts_uploaded}`);
		} else {
			s.update(line);
		}
	});

	if (response.status === "complete") {
		return response;
	} else if (response.status === "error") {
		throw new APIError({
			text: response.error,
			notes: response.messages.map((text) => ({ text })),
		});
	} else {
		return await pollExport(
			s,
			accountId,
			db,
			dumpOptions,
			response.at_bookmark,
			num_parts_uploaded
		);
	}
}
