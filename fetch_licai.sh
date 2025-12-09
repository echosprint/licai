#!/bin/bash

# Configuration
INPUT_FILE="products.txt"
OUTPUT_FILE="results.csv"
INTERVAL_SECONDS=8

# Get private key once
INIT_RESPONSE=$(curl -s -c cookies.txt -b cookies.txt \
  -X POST "https://xinxipilu.chinawealth.com.cn/lcxp-platService/product/getInitData" \
  -H "Content-Type: application/json" \
  -d '{}')

PRIVATE_KEY_RAW=$(echo "$INIT_RESPONSE" | jq -r '.data')
PRIVATE_KEY=$(echo "$PRIVATE_KEY_RAW" | \
  sed 's/-----BEGIN PRIVATE KEY----- /-----BEGIN PRIVATE KEY-----\n/' | \
  sed 's/ -----END PRIVATE KEY-----/\n-----END PRIVATE KEY-----/')
echo -e "$PRIVATE_KEY" > /tmp/private_key.pem

# Initialize CSV output
echo "prodName,prodRegCode" > "$OUTPUT_FILE"

# Prepare base request body template
BODY_TEMPLATE='{
  "orgName": "",
  "prodName": "",
  "prodRegCode": "",
  "pageNum": 1,
  "pageSize": 20,
  "prodStatus": "",
  "prodSpclAttr": "",
  "prodInvestNature": "",
  "prodOperateMode": "",
  "prodRiskLevel": "",
  "prodTermCode": "",
  "actDaysStart": null,
  "actDaysEnd": null
}'

# Read from products.txt and process each line
while IFS= read -r PRODUCT_NAME || [ -n "$PRODUCT_NAME" ]; do
  # Clean up the product name: trim, remove quotes (English & Chinese), remove all spaces
  PRODUCT_NAME=$(echo "$PRODUCT_NAME" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\''"'"'"'\'']*//' -e 's/["'\''"'"'"'\'']*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]//g')
  [ -z "$PRODUCT_NAME" ] && continue

  # Update prodName in body (compact JSON, no spaces)
  REQUEST_BODY=$(echo "$BODY_TEMPLATE" | jq -c --arg name "$PRODUCT_NAME" '.prodName = $name')

  # Generate signature
  SIGNATURE=$(echo -n "$REQUEST_BODY" | openssl dgst -sha256 -sign /tmp/private_key.pem | base64 | tr -d '\n')

  # Step 4: Make the API request
  RESULT=$(curl -s -b cookies.txt \
    -X POST "https://xinxipilu.chinawealth.com.cn/lcxp-platService/product/getProductList" \
    -H "Content-Type: application/json;charset=UTF-8" \
    -H "Accept: application/json" \
    -H "signature: $SIGNATURE" \
    -d "$REQUEST_BODY")

  # Extract prodName and prodRegCode, append to CSV
  PROD_NAME=$(echo "$RESULT" | jq -r '.data.list[0].prodName // empty')
  PROD_CODE=$(echo "$RESULT" | jq -r '.data.list[0].prodRegCode // empty')

  if [ -n "$PROD_NAME" ] && [ -n "$PROD_CODE" ]; then
    echo "$PROD_NAME,$PROD_CODE" >> "$OUTPUT_FILE"
    echo "$PROD_NAME,$PROD_CODE"
  fi

  sleep $INTERVAL_SECONDS

done < "$INPUT_FILE"

# Cleanup
rm -f /tmp/private_key.pem cookies.txt
