# Paywai Admin Access

# PRIVATE ADMIN URL:
# https://xonomo.site/control-9f2d8c7a4e1b6f03d5a9c8e2b7f14a60c3d8e5a1b9f6c2d7e4a0b8c5f1d3e6a9

# ALLOWED PUBLIC IP:
# 121.200.220.137

# ACCESS FLOW:
# 1. Open the private URL above.
# 2. The server checks the public IP.
# 3. Only the allowed network reaches the password screen.
# 4. Enter the admin password to receive an HttpOnly session cookie.
# 5. The old /admin path is intentionally a 404.
#
# IMPORTANT:
# The allowed IP is the public Internet IP of the authorized Wi-Fi connection.
# If the ISP changes the public IP, update this value in api/admin-gate.ts.
