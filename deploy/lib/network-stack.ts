import { StackProps as CdkStackProps, Stack, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as apprunner from "@aws-cdk/aws-apprunner-alpha";

export type NetworkProps = {
  readonly vpc: {
    readonly cidr: string;
    readonly maxAzs: number;
    readonly subnetConfiguration: {
      readonly cidrMask: number;
      readonly name: string;
      readonly subnetType: string;
    }[];
    readonly natGatewaysCount: number;
  };
  readonly hostedZoneName: string;
};

interface StackProps extends CdkStackProps {
  readonly networkProps: NetworkProps;
}

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly networkProps: NetworkProps;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.networkProps = props.networkProps;

    this.vpc = this.newVPC();
    this.newVPCConnector();
  }

  private newVPC(): ec2.Vpc {
    return new ec2.Vpc(this, "VPC", {
      vpcName: "vpc",
      ipAddresses: ec2.IpAddresses.cidr(this.networkProps.vpc.cidr),
      maxAzs: this.networkProps.vpc.maxAzs,
      subnetConfiguration: this.networkProps.vpc.subnetConfiguration.map(
        (subnet) => ({
          cidrMask: subnet.cidrMask,
          name: subnet.name,
          subnetType: this.getSubnetType(subnet.subnetType),
        })
      ),
      natGateways: this.networkProps.vpc.natGatewaysCount,
    });
  }

  private newVPCConnector(): void {
    const apiVPCConnectorSg = new ec2.SecurityGroup(
      this,
      "VPCConnectorSecurityGroup",
      {
        securityGroupName: "vpc-connector-sg",
        vpc: this.vpc,
      }
    );

    new CfnOutput(this, "VPCConnectorSgIdOutput", {
      exportName: "vpc-connector-sg-id",
      value: apiVPCConnectorSg.securityGroupId,
    });

    const vpcConnector = new apprunner.VpcConnector(this, "VPCConnector", {
      vpcConnectorName: "vpc-connector",
      vpc: this.vpc,
      vpcSubnets: this.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      securityGroups: [apiVPCConnectorSg],
    });

    new CfnOutput(this, "VPCConnectorSecretOutput", {
      exportName: "vpc-connector-arn",
      value: vpcConnector.vpcConnectorArn,
    });
  }

  private getSubnetType(subnet: string): ec2.SubnetType {
    switch (subnet) {
      case "public":
        return ec2.SubnetType.PUBLIC;
      case "isolated":
        return ec2.SubnetType.PRIVATE_ISOLATED;
      case "private":
        return ec2.SubnetType.PRIVATE_WITH_EGRESS;
      default:
        throw new Error("Invalid subnet type");
    }
  }
}
