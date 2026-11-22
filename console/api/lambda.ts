import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { type Deps, handle } from "./handlers.ts";
import { type Commands, DynamoTable } from "./table.ts";

const SECRET_PARAMETER = "/panelator/console/github_client_secret";
let cachedSecret: string | undefined;

function deps(): Deps {
  const env = process.env;
  const db = new DynamoDBClient({});
  const ssm = new SSMClient({});
  return {
    table: new DynamoTable(
      db,
      env.TABLE_NAME as string,
      {
        Put: PutItemCommand,
        Get: GetItemCommand,
        Delete: DeleteItemCommand,
        Query: QueryCommand,
        Update: UpdateItemCommand,
      } as unknown as Commands,
    ),
    keyHash: env.API_KEY_HASH ?? "",
    maintainer: env.MAINTAINER_LOGIN ?? "",
    clientId: env.GITHUB_CLIENT_ID ?? "",
    clientSecret: async () => {
      cachedSecret ??=
        (await ssm.send(new GetParameterCommand({ Name: SECRET_PARAMETER, WithDecryption: true }))).Parameter?.Value ??
        "";
      return cachedSecret;
    },
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** The Lambda entry point: one function behind the HTTP API wraps every handler. */
export async function handler(e: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const headers = Object.fromEntries(Object.entries(e.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v ?? ""]));
  if (e.cookies?.length) headers.cookie = e.cookies.join("; ");
  const body = e.isBase64Encoded ? Buffer.from(e.body ?? "", "base64").toString() : (e.body ?? "");
  const r = await handle(deps(), {
    method: e.requestContext.http.method,
    path: e.rawPath,
    query: (e.queryStringParameters ?? {}) as Record<string, string>,
    headers,
    body,
  });
  const { "set-cookie": setCookie, ...rest } = r.headers;
  return { statusCode: r.status, headers: rest, body: r.body, ...(setCookie ? { cookies: [setCookie] } : {}) };
}
