window.FaunaOccurrencePhotos = Object.create(null);

// Empty until an authorized source establishes an exact occurrence-to-image association.
// The export's Fotos values are filenames, not verified SIMBA URLs or occurrence mappings.
// Key by occurrence ID; require matching occurrenceId and individualId on every entry:
// { authorized: true, occurrenceId, individualId, url, credit, source, sourceUrl, license }.
