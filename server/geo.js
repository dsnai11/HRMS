export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = (n) => (n * Math.PI) / 180;
  const a =
    Math.sin(radians(lat2 - lat1) / 2) ** 2 +
    Math.cos(radians(lat1)) *
      Math.cos(radians(lat2)) *
      Math.sin(radians(lon2 - lon1) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
export function checkLocation(location, site, now = Date.now()) {
  if (
    !location ||
    typeof location.latitude !== "number" ||
    !Number.isFinite(location.latitude) ||
    Math.abs(location.latitude) > 90 ||
    typeof location.longitude !== "number" ||
    !Number.isFinite(location.longitude) ||
    Math.abs(location.longitude) > 180
  )
    throw new HttpError(400, "A valid GPS location is required.");
  if (
    typeof location.accuracy !== "number" ||
    !Number.isFinite(location.accuracy) ||
    location.accuracy <= 0 ||
    location.accuracy > site.max_accuracy
  )
    throw new HttpError(
      422,
      `GPS accuracy must be within ${site.max_accuracy} m. Move outdoors and try again.`,
    );
  if (
    typeof location.timestamp !== "number" ||
    !Number.isFinite(location.timestamp) ||
    now - location.timestamp > 60000 ||
    location.timestamp - now > 10000
  )
    throw new HttpError(
      422,
      "Location is stale. Obtain a fresh GPS reading and retry.",
    );
  if (location.mocked === true)
    throw new HttpError(422, "Mock locations cannot be used for attendance.");
  const distance = distanceMeters(
    location.latitude,
    location.longitude,
    site.latitude,
    site.longitude,
  );
  if (distance + location.accuracy > site.radius)
    throw new HttpError(
      422,
      `You are about ${Math.round(distance)} m from ${site.name}. Move inside its ${site.radius} m boundary; GPS uncertainty must also fit inside it.`,
    );
  return distance;
}
