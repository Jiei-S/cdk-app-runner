import { StackProps as CdkStackProps, Stack, Fn } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";

interface StackProps extends CdkStackProps {
  readonly vpc: ec2.Vpc;
}

export class DBBastionStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { vpc } = props;

    const dbBastionSg = new ec2.SecurityGroup(this, "DBBastionSecurityGroup", {
      securityGroupName: "db-bastion-sg",
      vpc,
      allowAllOutbound: true,
    });
    dbBastionSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Allow SSH"
    );

    const dbSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "DBSecurityGroup",
      Fn.importValue("db-sg-id")
    );
    dbSg.addIngressRule(dbBastionSg, ec2.Port.tcp(3306), "Allow Bastion");

    const userData = ec2.UserData.forLinux();
    userData
      .addCommands
      // install mysql client
      ();

    new ec2.Instance(this, "DBBastion", {
      instanceName: "db-bastion",
      vpc,
      securityGroup: dbBastionSg,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      userData,
      vpcSubnets: { subnets: vpc.publicSubnets },
      ssmSessionPermissions: true,
      keyName: "db-bastion-key",
    });
  }
}
