// ---------------------------------------------------------------------------
// Map Renderer — Interactive Geographic Maps
// ---------------------------------------------------------------------------
//
// Renders map components using Leaflet (loaded dynamically) or a
// static SVG fallback for environments without Leaflet.
//
// ---------------------------------------------------------------------------

import React, { useEffect, useRef, useState, useMemo } from "react";
import { MapComponent, MapMarker, MapPath } from "../../lib/interactive-types";

interface MapRendererProps {
  component: MapComponent;
  instanceId: string;
  className?: string;
}

const TILE_PROVIDERS = {
  openstreetmap: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  cartodb: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  stadia: {
    url: "https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
  },
};

export default function MapRenderer({ component, instanceId, className = "" }: MapRendererProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<unknown>(null);
  const [leaflet, setLeaflet] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [markers, setMarkers] = useState<MapMarker[]>(component.markers || []);
  const [paths, setPaths] = useState<MapPath[]>(component.paths || []);

  // Dynamically load Leaflet
  useEffect(() => {
    let cancelled = false;

    async function loadLeaflet() {
      try {
        // Check if Leaflet is already available globally
        if (typeof window !== "undefined" && (window as unknown as { L?: unknown }).L) {
          setLeaflet((window as unknown as { L: unknown }).L);
          return;
        }

        // Try to import Leaflet
        const L = await import("leaflet");
        setLeaflet(L.default || L);

        // Fix Leaflet's default marker icon issue
        if (L.default?.Icon) {
          delete (L.default.Icon.Default.prototype as { _getIconUrl?: () => string })._getIconUrl;
          L.default.Icon.Default.mergeOptions({
            iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
            iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
            shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
          });
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load Leaflet");
        }
      }
    }

    loadLeaflet();

    return () => {
      cancelled = true;
    };
  }, []);

  // Initialize map when Leaflet is loaded
  useEffect(() => {
    if (!leaflet || !mapContainerRef.current || map) return;

    const L = leaflet as typeof import("leaflet");
    const tileProvider = TILE_PROVIDERS[component.tileProvider || "openstreetmap"];

    const newMap = L.map(mapContainerRef.current, {
      center: component.center,
      zoom: component.zoom,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer(tileProvider.url, {
      attribution: tileProvider.attribution,
      maxZoom: 19,
    }).addTo(newMap);

    setMap(newMap);

    // Add markers
    const markerLayer = L.layerGroup().addTo(newMap);
    markers.forEach(marker => {
      const icon = marker.icon
        ? L.divIcon({
            className: "custom-marker",
            html: `<div style="font-size: 24px;">${marker.icon}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 30],
          })
        : marker.color
        ? L.divIcon({
            className: "custom-marker",
            html: `<div style="width: 12px; height: 12px; border-radius: 50%; background: ${marker.color}; border: 2px solid white; box-shadow: 0 0 0 2px ${marker.color};"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 16],
          })
        : undefined;

      const m = L.marker(marker.position, { icon }).addTo(markerLayer);
      if (marker.title || marker.description) {
        m.bindPopup(`
          <strong>${marker.title || "Marker"}</strong>
          ${marker.description ? `<br/>${marker.description}` : ""}
        `);
      }
    });

    // Add paths
    const pathLayer = L.layerGroup().addTo(newMap);
    paths.forEach(path => {
      const polyline = L.polyline(path.coordinates, {
        color: path.color || "#3b82f6",
        weight: path.weight || 3,
        opacity: 0.8,
      }).addTo(pathLayer);

      if (path.closed) {
        L.polygon(path.coordinates, {
          color: path.color || "#3b82f6",
          weight: path.weight || 3,
          fillColor: path.color || "#3b82f6",
          fillOpacity: 0.1,
        }).addTo(pathLayer);
      }
    });

    // Fit bounds to show all markers/paths if there are any
    const allLayers = [markerLayer, pathLayer];
    const bounds = L.featureGroup(allLayers).getBounds();
    if (bounds.isValid()) {
      newMap.fitBounds(bounds, { padding: [20, 20], maxZoom: component.zoom });
    }

    return () => {
      newMap.remove();
    };
  }, [leaflet, component.center, component.zoom, component.tileProvider, markers, paths]);

  // Fallback static map rendering (when Leaflet fails to load)
  const renderStaticMap = useMemo(() => {
    if (!loadError) return null;

    // Simple static map using a static image service or just a placeholder
    const { center, zoom, markers: mks, paths: pths } = component;
    const [lat, lng] = center;

    // Generate a static map URL (using a free static map service concept)
    // In practice, you'd use a real static maps API
    const markerParams = mks.map(m => `${m.position[0]},${m.position[1]},lightblue1`).join("|");
    const staticMapUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=${zoom}&size=600x400&markers=${markerParams}`;

    const ariaLabel = `Static map centered at ${lat}, ${lng}`;
    const altText = `Map showing ${mks.length} marker(s) and ${pths.length} path(s)`;

    return (
      <div className="map-static-fallback" role="img" aria-label={ariaLabel}>
        <img
          src={staticMapUrl}
          alt={altText}
          onError={(e) => {
            e.currentTarget.style.display = "none";
            e.currentTarget.nextElementSibling?.classList.remove("hidden");
          }}
        />
        <div className="static-map-error hidden">
          <p>Unable to load map. Showing coordinates:</p>
          <ul>
            {mks.map(m => (
              <li key={m.id}>{m.title || m.id}: {m.position[0].toFixed(4)}, {m.position[1].toFixed(4)}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }, [loadError, component]);

  return (
    <div className={`map-renderer ${className}`} data-instance-id={instanceId}>
      <div className="map-header">
        <h3 className="map-title">{component.title}</h3>
        {component.description && <p className="map-description">{component.description}</p>}
      </div>

      <div className="map-container" style={{ height: component.height || 400 }}>
        {loadError ? (
          renderStaticMap
        ) : (
          <div
            ref={mapContainerRef}
            className="map-leaflet-container"
            style={{ width: "100%", height: "100%" }}
            role="application"
            aria-label={component.title}
          />
        )}

        {loadError && !renderStaticMap && (
          <div className="map-loading" role="status" aria-live="polite">
            <div className="loading-spinner" aria-hidden="true" />
            <span>Loading map...</span>
          </div>
        )}
      </div>

      {(component.markers?.length || component.paths?.length) && (
        <details className="map-legend">
          <summary>Map Details</summary>
          <div className="legend-content">
            {component.markers?.map((marker) => (
              <div key={marker.id} className="legend-item">
                <span className="legend-marker" style={{ backgroundColor: marker.color }} />
                <span>{marker.title || marker.id}</span>
                {marker.description && <span className="legend-desc">{marker.description}</span>}
              </div>
            ))}
            {component.paths?.map((path) => (
              <div key={path.id} className="legend-item">
                <span className="legend-path" style={{ backgroundColor: path.color }} />
                <span>{path.id} ({path.coordinates.length} points)</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}