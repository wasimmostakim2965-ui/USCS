/**
 * The AWS application tier must be a horizontally scalable Auto Scaling group,
 * not a single instance — and it must stay honest about what it scales.
 *
 * Two things are pinned here, and both are the kind of drift a plan review would
 * miss:
 *
 *   * the topology the worker's queue semantics actually allow. `claim` is
 *     `for update skip locked` (`packages/database/src/sql-queue.ts`), so N
 *     instances can drain one queue without double-processing. If the group is
 *     ever replaced by a lone instance, this test fails.
 *   * that the scaling is *not* described as a hard multi-tenant boundary or as
 *     closed release gates. The private subnet is evidence toward gate 6, not
 *     the gate, and this test keeps the Terraform from claiming otherwise.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const terraformDir = fileURLToPath(new URL("../../infra/aws/terraform/", import.meta.url));
const compute = readFileSync(`${terraformDir}compute.tf`, "utf8");
const network = readFileSync(`${terraformDir}network.tf`, "utf8");
const loadBalancer = readFileSync(`${terraformDir}load-balancer.tf`, "utf8");
const observability = readFileSync(`${terraformDir}observability.tf`, "utf8");
const variables = readFileSync(`${terraformDir}variables.tf`, "utf8");
const outputs = readFileSync(`${terraformDir}outputs.tf`, "utf8");

describe("the AWS application tier scales horizontally", () => {
  it("runs an Auto Scaling group across every private subnet, not one instance", () => {
    expect(compute).toContain('resource "aws_autoscaling_group" "app"');
    expect(compute).toContain("vpc_zone_identifier = aws_subnet.private[*].id");
    // No bare instance resource left behind.
    expect(compute).not.toMatch(/resource\s+"aws_instance"\s+"app"/);
    expect(loadBalancer).not.toContain("aws_lb_target_group_attachment");
  });

  it("defines the group from a launch template whose bootstrap is base64-encoded", () => {
    // A launch template does not encode user data for you; a raw templatefile
    // there is rejected or silently mangled. The encoding is load-bearing.
    expect(compute).toContain('resource "aws_launch_template" "app"');
    expect(compute).toContain("user_data = base64encode(templatefile(");
  });

  it("lets the load balancer decide instance health, not just the EC2 status check", () => {
    // The target group's /healthz is the documented liveness check; making ELB
    // health the group's check keeps "the LB thinks it is healthy" and "the
    // runbook's curl passes" the same statement.
    expect(compute).toContain('health_check_type         = "ELB"');
    expect(compute).toContain("target_group_arns         = [aws_lb_target_group.web.arn]");
  });

  it("scales on a real signal, and can be turned off without removing the group", () => {
    expect(compute).toContain('resource "aws_autoscaling_policy" "cpu"');
    expect(compute).toContain('predefined_metric_type = "ASGAverageCPUUtilization"');
    expect(compute).toContain("count = var.autoscaling_enabled ? 1 : 0");
    expect(variables).toContain('variable "autoscaling_enabled"');
  });

  it("defaults to at least one instance per availability zone", () => {
    // min ≥ 2 is what makes a single instance failure a capacity dip rather than
    // downtime. One per AZ is the point of the two-AZ network.
    const min = variables.match(/variable "app_min_size"[\s\S]*?default\s*=\s*(\d+)/);
    expect(min, "app_min_size must have a numeric default").toBeTruthy();
    expect(Number(min![1])).toBeGreaterThanOrEqual(2);
    expect(network).toContain("aws_subnet.private");
    expect(network.match(/count\s*=\s*2/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keeps the egress path per-AZ when asked, so a scaled-out instance still reaches the engines", () => {
    // One shared NAT is a single point of failure for egress; the per-AZ form is
    // the upgrade. The private route table must follow the AZ it belongs to.
    expect(variables).toContain('variable "nat_gateway_per_az"');
    expect(network).toContain("var.nat_gateway_per_az ? count.index : 0");
  });

  it("alarms on the group, not on an instance id that no longer exists", () => {
    expect(observability).toContain("AutoScalingGroupName = aws_autoscaling_group.app.name");
    expect(observability).not.toContain("InstanceId = aws_instance.app.id");
    expect(outputs).toContain('output "autoscaling_group_name"');
    expect(outputs).not.toContain("aws_instance.app.id");
  });

  it("does not describe the shared tier as a hard multi-tenant boundary or a closed gate", () => {
    // The honesty constraint: scaling out is capacity, not isolation. Every
    // instance still shares one daemon and one database; the docs carry the
    // limit, and the Terraform must not claim more.
    for (const source of [compute, network, outputs]) {
      expect(source.toLowerCase()).not.toContain("hard multi-tenant boundary");
      expect(source.toLowerCase()).not.toContain("gate 6 passed");
    }
  });
});
