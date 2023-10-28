import {
  StackProps as CdkStackProps,
  Stack,
  CfnOutput,
  SecretValue,
  Duration,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as kms from "aws-cdk-lib/aws-kms";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";

export type DBProps = {
  readonly cluster: {
    readonly preferredMaintenanceWindow: string;
    readonly backtrackWindow: number;
    readonly instance: {
      readonly writer: {
        readonly instanceSize: string;
        readonly instanceClass: string;
      };
      readonly reader: {
        readonly instanceSize: string;
        readonly instanceClass: string;
      };
    };
    readonly backup: {
      readonly retention: number;
      readonly preferredWindow: string;
    };
    readonly scalableTarget: {
      readonly minCapacity: number;
      readonly maxCapacity: number;
      readonly targetValue: number;
      readonly scaleInCooldown: number;
      readonly scaleOutCooldown: number;
    };
  };
};

interface StackProps extends CdkStackProps {
  readonly dbProps: DBProps;
  readonly vpc: ec2.Vpc;
}

export class DBStack extends Stack {
  readonly dbProps: DBProps;
  readonly vpc: ec2.Vpc;

  private readonly role: iam.Role;
  private readonly securityGroup: ec2.SecurityGroup;
  private readonly paramaterGroup: {
    cluster: rds.ParameterGroup;
    instance: rds.ParameterGroup;
  };
  private readonly subnetGroup: rds.SubnetGroup;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.dbProps = props.dbProps;
    this.vpc = props.vpc;

    this.role = this.newRole();
    this.securityGroup = this.newSecurityGroup();
    this.paramaterGroup = this.newParameterGroup();
    this.subnetGroup = this.newSubnetGroup();
    this.newCluster();
  }

  private newRole(): iam.Role {
    return new iam.Role(this, "DBRole", {
      roleName: "db-role",
      assumedBy: new iam.ServicePrincipal("rds.amazonaws.com"),
    });
  }

  private newSecurityGroup(): ec2.SecurityGroup {
    const dbSg = new ec2.SecurityGroup(this, "DBSecurityGroup", {
      securityGroupName: "db-sg",
      vpc: this.vpc,
      allowAllOutbound: true,
    });

    new CfnOutput(this, "DBSecurityGroupIdOutput", {
      exportName: "db-sg-id",
      value: dbSg.securityGroupId,
    });

    return dbSg;
  }

  private newParameterGroup(): {
    cluster: rds.ParameterGroup;
    instance: rds.ParameterGroup;
  } {
    const cluster = new rds.ParameterGroup(this, "ClusterParameterGroup", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_03_0,
      }),
    });
    cluster.addParameter("aws_default_s3_role", this.role.roleArn);

    const instance = new rds.ParameterGroup(this, "InstanceParameterGroup", {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_03_0,
      }),
    });

    return { cluster, instance };
  }

  private newSubnetGroup(): rds.SubnetGroup {
    return new rds.SubnetGroup(this, "SubnetGroup", {
      vpc: this.vpc,
      subnetGroupName: "db-subnet-group",
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      description: "Subnet group for rds",
    });
  }

  private newCluster(): rds.DatabaseCluster {
    const initDBSecret = sm.Secret.fromSecretNameV2(
      this,
      "DBInitSecret",
      "db-init-secret"
    );
    const dbSecret = new sm.Secret(this, "DBSecret", {
      secretName: "db-secret",
      secretObjectValue: {
        username: SecretValue.unsafePlainText(
          initDBSecret.secretValueFromJson("username").unsafeUnwrap()
        ),
        password: SecretValue.unsafePlainText(
          initDBSecret.secretValueFromJson("password").unsafeUnwrap()
        ),
      },
    });

    const cluster = new rds.DatabaseCluster(this, "DatabaseCluster", {
      defaultDatabaseName: "db",
      clusterIdentifier: "db-cluster",
      parameterGroup: this.paramaterGroup.cluster,
      securityGroups: [this.securityGroup],
      subnetGroup: this.subnetGroup,
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_03_0,
      }),
      credentials: rds.Credentials.fromSecret(dbSecret),
      preferredMaintenanceWindow:
        this.dbProps.cluster.preferredMaintenanceWindow,
      storageEncrypted: true,
      storageEncryptionKey: kms.Key.fromLookup(this, "StorageEncryptionKey", {
        aliasName: "alias/aws/rds",
      }),
      backtrackWindow: Duration.seconds(this.dbProps.cluster.backtrackWindow),
      cloudwatchLogsExports: ["error", "slowquery"],
      writer: rds.ClusterInstance.provisioned("writer", {
        instanceIdentifier: "instance1",
        instanceType: ec2.InstanceType.of(
          this.getRDSInstanceClass(
            this.dbProps.cluster.instance.writer.instanceClass
          ),
          this.getRDSInstanceSize(
            this.dbProps.cluster.instance.writer.instanceSize
          )
        ),
        parameterGroup: this.paramaterGroup.instance,
      }),
      readers: [
        rds.ClusterInstance.provisioned("reader1", {
          instanceIdentifier: "instance2",
          instanceType: ec2.InstanceType.of(
            this.getRDSInstanceClass(
              this.dbProps.cluster.instance.reader.instanceClass
            ),
            this.getRDSInstanceSize(
              this.dbProps.cluster.instance.reader.instanceSize
            )
          ),
          parameterGroup: this.paramaterGroup.instance,
        }),
      ],
      storageType: rds.DBClusterStorageType.AURORA,
      vpc: this.vpc,
      backup: {
        retention: Duration.days(this.dbProps.cluster.backup.retention),
        preferredWindow: this.dbProps.cluster.backup.preferredWindow,
      },
      deletionProtection: true,
    });

    const scalableTarget = new appscaling.ScalableTarget(
      this,
      "ScalableTarget",
      {
        serviceNamespace: appscaling.ServiceNamespace.RDS,
        maxCapacity: this.dbProps.cluster.scalableTarget.maxCapacity,
        minCapacity: this.dbProps.cluster.scalableTarget.minCapacity,
        resourceId: `cluster:${cluster.clusterIdentifier}`,
        scalableDimension: "rds:cluster:ReadReplicaCount",
      }
    );
    scalableTarget.scaleToTrackMetric("Tracking", {
      policyName: "db-scale-policy",
      targetValue: this.dbProps.cluster.scalableTarget.targetValue,
      predefinedMetric:
        appscaling.PredefinedMetric.RDS_READER_AVERAGE_CPU_UTILIZATION,
      scaleInCooldown: Duration.seconds(
        this.dbProps.cluster.scalableTarget.scaleInCooldown
      ),
      scaleOutCooldown: Duration.seconds(
        this.dbProps.cluster.scalableTarget.scaleOutCooldown
      ),
    });

    return cluster;
  }

  private getRDSInstanceSize(size: string): ec2.InstanceSize {
    switch (size) {
      case "small":
        return ec2.InstanceSize.SMALL;
      case "medium":
        return ec2.InstanceSize.MEDIUM;
      case "large":
        return ec2.InstanceSize.LARGE;
      default:
        throw new Error("Invalid instance size");
    }
  }

  private getRDSInstanceClass(instanceClass: string): ec2.InstanceClass {
    switch (instanceClass) {
      case "t3":
        return ec2.InstanceClass.T3;
      case "t3a":
        return ec2.InstanceClass.T3A;
      case "t4g":
        return ec2.InstanceClass.T4G;
      default:
        throw new Error("Invalid instance class");
    }
  }
}
