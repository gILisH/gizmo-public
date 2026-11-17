// Resolve a place name / address → coordinates via OpenStreetMap Nominatim (free, no API
// key; just wants a descriptive User-Agent and low volume). Lets the model drop a pin from
// a NAME ("Capybara Cafe, Phuket") instead of having to invent lat/lng from search snippets.
export interface GeoResult {
  lat: number
  lng: number
  label: string
}

export async function geocode(query: string, fetchImpl: typeof fetch = fetch): Promise<GeoResult | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'gizmo-family-assistant/1.0 (personal use)' } })
    if (!res.ok) return null
    const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>
    const hit = arr[0]
    if (!hit) return null
    const lat = parseFloat(hit.lat)
    const lng = parseFloat(hit.lon)
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null
    return { lat, lng, label: hit.display_name }
  } catch {
    return null
  }
}
