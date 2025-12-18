#!/bin/bash

OUTPUT="API_merged_shiftly_code.txt"
ROUTE_FILTER="$1"   # Optional parameter: example → "./merge.sh auth.js"

echo "Merging Shiftly API source files into $OUTPUT ..."
echo "Route filter: ${ROUTE_FILTER:-ALL FILES}"

{
  echo "===== createCrudRouter.js ====="
  cat createCrudRouter.js
  echo -e "\n\n"

  echo "===== db.js ====="
  cat db.js
  echo -e "\n\n"

  echo "===== index.js ====="
  cat index.js
  echo -e "\n\n"

  echo "===== ROUTES FOLDER FILES ====="

  if [ -z "$ROUTE_FILTER" ]; then
    # No parameter → merge ALL route files
    for FILE in routes/*.js; do
      echo "===== $FILE ====="
      cat "$FILE"
      echo -e "\n\n"
    done
  else
    # Parameter provided → merge ONLY that single file
    FILE="routes/$ROUTE_FILTER"

    if [ -f "$FILE" ]; then
      echo "===== $FILE ====="
      cat "$FILE"
      echo -e "\n\n"
    else
      echo "ERROR: File '$FILE' does not exist!"
    fi
  fi
} > "$OUTPUT"

echo "Done! File created: $OUTPUT"
