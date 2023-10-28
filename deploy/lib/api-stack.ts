import { StackProps as CdkStackProps, Stack, Fn, Aws } from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Construct } from "constructs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as aws_apprunner from "aws-cdk-lib/aws-apprunner";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecrdeploy from "cdk-ecr-deployment";
import * as path from "path";

type AppRunnerProps = {
  readonly cpu: number;
  readonly memory: number;
  readonly healthCheck: {
    readonly interval: number;
    readonly path: string;
    readonly timeout: number;
    readonly healthyThreshold: number;
    readonly unhealthyThreshold: number;
    readonly protocol: string;
  };
};

export type APIProps = {
  readonly appRunner: AppRunnerProps;
};

interface StackProps extends CdkStackProps {
  readonly envType: "dev" | "prod";
  readonly commitHash: string;
  readonly apiProps: APIProps;
}

export class APIStack extends Stack {
  private readonly PORT = 4000;
  private readonly MYSQL_PORT = 3306;
  private readonly envType: string;
  private readonly commitHash: string;
  private readonly apiProps: APIProps;

  private readonly repository: ecr.IRepository;
  private readonly appRunner: aws_apprunner.CfnService;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.envType = props.envType;
    this.commitHash = props.commitHash;
    this.apiProps = props.apiProps;

    this.repository = this.imageBuildAndPush();
    this.addIngessRuleFromAPI();
    this.appRunner = this.newAppRunner();
    this.newWAF();
  }

  private imageBuildAndPush(): ecr.IRepository {
    const repository = new ecr.Repository(this, "APIRepository", {
      repositoryName: "api",
      imageScanOnPush: true,
    });

    const image = new ecrAssets.DockerImageAsset(this, "DockerImageAsset", {
      directory: path.join(__dirname, "../..", "api"),
      file: `build/${this.envType}/Dockerfile`,
    });
    new ecrdeploy.ECRDeployment(this, "DeployDockerImage", {
      src: new ecrdeploy.DockerImageName(image.imageUri),
      dest: new ecrdeploy.DockerImageName(repository.repositoryUri),
    });

    return repository;
  }

  private addIngessRuleFromAPI(): void {
    const vpcConnectorSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "APIVPCConnectorSecurityGroup",
      Fn.importValue("vpc-connector-sg-id")
    );

    const dbSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "DBSecurityGroup",
      Fn.importValue("db-sg-id")
    );
    dbSg.addIngressRule(
      vpcConnectorSg,
      ec2.Port.tcp(this.MYSQL_PORT),
      "Allow API"
    );
  }

  private newAppRunner(): aws_apprunner.CfnService {
    const { healthCheck, cpu, memory } = this.apiProps.appRunner;

    const appRunner = new aws_apprunner.CfnService(this, "APIAppRunner", {
      serviceName: "api",
      sourceConfiguration: {
        authenticationConfiguration: {
          accessRoleArn: new iam.Role(this, "ECRAccessRole", {
            roleName: "api-access-role",
            assumedBy: new iam.ServicePrincipal(
              "build.apprunner.amazonaws.com"
            ),
            managedPolicies: [
              iam.ManagedPolicy.fromAwsManagedPolicyName(
                "service-role/AWSAppRunnerServicePolicyForECRAccess"
              ),
            ],
          }).roleArn,
        },
        autoDeploymentsEnabled: true,
        imageRepository: {
          imageIdentifier: `${this.repository.repositoryUri}:${this.commitHash}`,
          imageRepositoryType: "ECR",
          imageConfiguration: {
            port: String(this.PORT),
            runtimeEnvironmentSecrets: [
              {
                name: "MYSQL_HOST",
                value: ssm.StringParameter.fromSecureStringParameterAttributes(
                  this,
                  "DBHostParameter",
                  {
                    parameterName: "/db/host",
                    version: 1,
                  }
                ).parameterArn,
              },
              {
                name: "MYSQL_READ_HOST",
                value: ssm.StringParameter.fromSecureStringParameterAttributes(
                  this,
                  "DBReadHostParameter",
                  {
                    parameterName: "/db/read-host",
                    version: 1,
                  }
                ).parameterArn,
              },
              {
                name: "MYSQL_PORT",
                value: ssm.StringParameter.fromSecureStringParameterAttributes(
                  this,
                  "DBPortParameter",
                  {
                    parameterName: "/db/port",
                    version: 1,
                  }
                ).parameterArn,
              },
              {
                name: "MYSQL_USER",
                value: ssm.StringParameter.fromSecureStringParameterAttributes(
                  this,
                  "DBUserParameter",
                  {
                    parameterName: "/db/username",
                    version: 1,
                  }
                ).parameterArn,
              },
              {
                name: "MYSQL_PASSWORD",
                value: ssm.StringParameter.fromSecureStringParameterAttributes(
                  this,
                  "DBPasswordParameter",
                  {
                    parameterName: "/db/password",
                    version: 1,
                  }
                ).parameterArn,
              },
              {
                name: "MYSQL_DATABASE",
                value: ssm.StringParameter.fromSecureStringParameterAttributes(
                  this,
                  "DBDatabaseParameter",
                  {
                    parameterName: "/db/dbname",
                    version: 1,
                  }
                ).parameterArn,
              },
              {
                name: "TZ",
                value: ssm.StringParameter.fromSecureStringParameterAttributes(
                  this,
                  "DBTzParameter",
                  {
                    parameterName: "/db/tz",
                    version: 1,
                  }
                ).parameterArn,
              },
            ],
          },
        },
      },
      healthCheckConfiguration: {
        interval: healthCheck.interval,
        path: healthCheck.path,
        timeout: healthCheck.timeout,
        healthyThreshold: healthCheck.healthyThreshold,
        unhealthyThreshold: healthCheck.unhealthyThreshold,
        protocol: healthCheck.protocol,
      },
      instanceConfiguration: {
        instanceRoleArn: new iam.Role(this, "APIInstanceRole", {
          roleName: "api-instance-role",
          assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com"),
          inlinePolicies: {
            SystemsManagerParametersPolicy: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  actions: ["ssm:GetParameters", "ssm:DescribeParameters"],
                  resources: [
                    `arn:aws:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/db/*`,
                    `arn:aws:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/api/*`,
                  ],
                  effect: iam.Effect.ALLOW,
                }),
              ],
            }),
          },
        }).roleArn,
        cpu: String(cpu),
        memory: String(memory),
      },
      networkConfiguration: {
        egressConfiguration: {
          egressType: "VPC",
          vpcConnectorArn: Fn.importValue("vpc-connector-arn"),
        },
        ingressConfiguration: {
          isPubliclyAccessible: true,
        },
      },
    });

    // Custom Domain

    // const apiDomain = "api.example.com";
    // new cr.AwsCustomResource(this, "APICustomDomain", {
    //   onCreate: {
    //     service: "AppRunner",
    //     action: "associateCustomDomain",
    //     parameters: {
    //       DomainName: apiDomain,
    //       ServiceArn: appRunner.attrServiceArn,
    //       EnableWWWSubdomain: false,
    //     },
    //     physicalResourceId: cr.PhysicalResourceId.of("APICustomDomain"),
    //   },
    //   onDelete: {
    //     service: "AppRunner",
    //     action: "disassociateCustomDomain",
    //     parameters: {
    //       DomainName: apiDomain,
    //       ServiceArn: appRunner.attrServiceArn,
    //     },
    //     physicalResourceId: cr.PhysicalResourceId.of("APICustomDomain"),
    //   },
    //   policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
    //     resources: [appRunner.attrServiceArn],
    //   }),
    // });

    return appRunner;
  }

  private newWAF(): void {
    const webAcl = new wafv2.CfnWebACL(this, "WebACL", {
      name: "api-waf",
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      rules: [
        {
          name: "AWSManagedRulesSQLiRuleSet",
          overrideAction: { none: {} },
          priority: 0,
          visibilityConfig: {
            metricName: "AWSManagedRulesSQLiRuleSet",
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesSQLiRuleSet",
              excludedRules: [
                {
                  name: "SQLi_QUERYARGUMENTS",
                },
              ],
            },
          },
        },
        {
          name: "AWSManagedRulesCommonRuleSet",
          overrideAction: { none: {} },
          priority: 1,
          visibilityConfig: {
            metricName: "AWSManagedRulesCommonRuleSet",
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              excludedRules: [
                {
                  name: "CrossSiteScripting_BODY",
                },
                {
                  name: "SizeRestrictions_BODY",
                },
                {
                  name: "SizeRestrictions_QUERYSTRING",
                },
              ],
            },
          },
        },
        {
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          overrideAction: { none: {} },
          priority: 2,
          visibilityConfig: {
            metricName: "AWSManagedRulesKnownBadInputsRuleSet",
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
        },
        {
          name: "AWSManagedRulesAmazonIpReputationList",
          overrideAction: { none: {} },
          priority: 3,
          visibilityConfig: {
            metricName: "AWSManagedRulesAmazonIpReputationList",
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
              excludedRules: [
                {
                  name: "AWSManagedIPReputationList",
                },
              ],
            },
          },
        },
      ],
      visibilityConfig: {
        metricName: "api-waf",
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
      },
    });
    new wafv2.CfnWebACLAssociation(this, "APIWebACLAssociation", {
      resourceArn: this.appRunner.attrServiceArn,
      webAclArn: webAcl.attrArn,
    });
  }
}
