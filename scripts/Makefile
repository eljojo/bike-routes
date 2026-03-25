# Route generation scripts
# Usage: make santiago

SHELL := bash
NODE := node --max-old-space-size=16384

# Santiago — Pedaleable catastro + OSM
SANTIAGO_SOURCE := https://raw.githubusercontent.com/pedaleable/mapa-catastro/refs/heads/gh-pages/datos/catastro.geojson
SANTIAGO_BOUNDS := -33.66,-70.83,-33.30,-70.48
SANTIAGO_LIMIT := 50

.PHONY: santiago santiago-propose santiago-generate

santiago: santiago-propose santiago-generate

santiago-propose:
	$(NODE) suggest-routes.mjs \
		--city santiago \
		--source "$(SANTIAGO_SOURCE)" \
		--bounds "$(SANTIAGO_BOUNDS)" \
		--content-dir .. \
		--output /tmp/santiago-proposals.json

santiago-generate:
	$(NODE) generate-routes.mjs \
		--proposals /tmp/santiago-proposals.json \
		--output ../santiago \
		--limit $(SANTIAGO_LIMIT)
