// Network: a two-tier VPC.
//
// The application host sits in a private subnet with no route to the internet
// for inbound traffic. It reaches Supabase and the engines through a NAT
// gateway, and is reachable from the load balancer only. That shape is what
// makes gate 6 (direct origin access denied) a topology property rather than a
// promise: the origin has no public address to reach in the first place.
//
// Two availability zones, because a single-AZ load balancer is not a load
// balancer. The host itself is one instance in this shape; the second AZ exists
// so the ALB and its subnet are not a single point of failure, and so a second
// host can be added without rebuilding the network.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project}-${var.environment}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-${var.environment}-igw" }
}

// Public subnets: the load balancer and the NAT gateway only. Nothing else.
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${var.project}-${var.environment}-public-${count.index + 1}" }
}

// Private subnets: the application host. No route to the internet gateway.
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index + 8)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = { Name = "${var.project}-${var.environment}-private-${count.index + 1}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.project}-${var.environment}-nat" }
}

// One NAT gateway, in the first public subnet. It is the only egress path, and
// the only cost the private subnet adds. A second NAT per AZ is the availability
// upgrade; this shape keeps one and says so.
resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]

  tags = { Name = "${var.project}-${var.environment}-nat" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.project}-${var.environment}-public-rt" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${var.project}-${var.environment}-private-rt" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

// --- VPC endpoints -----------------------------------------------------------
// SSM Session Manager is the access path, so it must work without a route to the
// internet through the NAT for every SSH-equivalent call. The interface
// endpoints below keep session traffic on the AWS network and off the NAT.

resource "aws_security_group" "endpoints" {
  name        = "${var.project}-${var.environment}-endpoints"
  description = "Interface endpoints reachable from the application host"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTPS from the application host"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  tags = { Name = "${var.project}-${var.environment}-endpoints" }
}

resource "aws_vpc_endpoint" "ssm" {
  for_each = toset(["ssm", "ssmmessages", "ec2messages"])

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = { Name = "${var.project}-${var.environment}-${each.value}" }
}
