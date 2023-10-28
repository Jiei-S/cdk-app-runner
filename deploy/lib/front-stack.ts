import {
  StackProps as CdkStackProps,
  Stack,
  aws_cloudfront,
  Aws,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";

interface StackProps extends CdkStackProps {}

export class FrontStack extends Stack {
  private readonly originBucket: s3.Bucket;
  private readonly cloudFrontDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.originBucket = this.newOriginBucket();
    this.cloudFrontDistribution = this.newCloudFrontDistribution();
    this.s3Deploy();
  }

  private newOriginBucket(): s3.Bucket {
    return new s3.Bucket(this, "OriginFrontBucket", {
      bucketName: "front-hosting",
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
  }

  private newCloudFrontDistribution(): cloudfront.Distribution {
    const cloudfrontLogsBucket = new s3.Bucket(this, "CloudFrontLogsBucket", {
      bucketName: "cloudfront-logs",
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    const originAccessControl = new aws_cloudfront.CfnOriginAccessControl(
      this,
      "OriginAccessControl",
      {
        originAccessControlConfig: {
          name: "origin-access-control",
          originAccessControlOriginType: "s3",
          signingBehavior: "always",
          signingProtocol: "sigv4",
        },
      }
    );

    const subDomain = "app";
    const frontDomain = `${subDomain}.example.com`;
    const cf = new cloudfront.Distribution(this, "CloudFrontDistribution", {
      defaultBehavior: {
        origin: new origins.S3Origin(this.originBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      defaultRootObject: "index.html",
      certificate: acm.Certificate.fromCertificateArn(
        this,
        "ACMCertificate",
        `arn:aws:acm:${Aws.REGION}:${Aws.ACCOUNT_ID}:certificate/path-to-certificate`
      ),
      domainNames: [frontDomain],
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
      enableLogging: true,
      logBucket: cloudfrontLogsBucket,
    });

    const cfnDistribution = cf.node
      .defaultChild as aws_cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity",
      ""
    );
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.0.OriginAccessControlId",
      originAccessControl.attrId
    );

    const hostedZoneId = ssm.StringParameter.fromStringParameterName(
      this,
      "HostedZoneId",
      `/front/hosted-zone-id`
    ).stringValue;
    const hostedZoneName = ssm.StringParameter.fromStringParameterName(
      this,
      "HostedZoneName",
      `/front/hosted-zone-name`
    ).stringValue;

    new route53.ARecord(this, "FrontARecord", {
      zone: route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId,
        zoneName: hostedZoneName,
      }),
      recordName: subDomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(cf)),
    });

    this.originBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [`${this.originBucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            "AWS:SourceArn": `arn:aws:cloudfront::${Aws.ACCOUNT_ID}:distribution/${cf.distributionId}`,
          },
        },
      })
    );

    return cf;
  }

  private s3Deploy(): void {
    new s3deploy.BucketDeployment(this, "FrontBucketDeployment", {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "../../", "front", "dist")),
      ],
      destinationBucket: this.originBucket,
      distribution: this.cloudFrontDistribution,
      distributionPaths: ["/*"],
    });
  }
}
