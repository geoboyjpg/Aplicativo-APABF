window.FaunaIndividualPhotos = Object.create(null);

// The occurrence export has photo filenames, not URLs; never infer public image paths from them.
// Use the individual identifier as the key and add only authorized photo records:
// { authorized: true, url, credit, source, sourceUrl, license }.
