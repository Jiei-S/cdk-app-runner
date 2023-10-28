#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { APIProps, APIStack } from "../lib/api-stack";

import { NetworkProps, NetworkStack } from "../lib/network-stack";
import { DBProps, DBStack } from "../lib/db-stack";

type EnvProps = {
  readonly api: APIProps;
  readonly network: NetworkProps;
  readonly db: DBProps;
};

const app = new cdk.App();

const envType = app.node.tryGetContext("env") as "dev" | "prod";
const commitHash = app.node.tryGetContext("commit") as string;

const {
  api: apiProps,
  network: networkProps,
  db: dbProps,
} = app.node.tryGetContext(envType) as EnvProps;

const network = new NetworkStack(app, "network-stack", {
  networkProps,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const db = new DBStack(app, "db-stack", {
  dbProps,
  vpc: network.vpc,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
db.addDependency(network);

const api = new APIStack(app, "api-stack", {
  envType,
  commitHash,
  apiProps,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
api.addDependency(network);
api.addDependency(db);
