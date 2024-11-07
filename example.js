import { writeFile, appendFile } from "fs/promises";

// Read access token from Environment
const STORYBLOK_ACCESS_TOKEN = process.env.STORYBLOK_ACCESS_TOKEN;
// Read access token from Environment
const STORYBLOK_VERSION = process.env.STORYBLOK_VERSION;

async *fetchAllStoryMarkets() {

}

async function *myFetchAllDataInParallel(url, perPage = 25, numOfParallelRequests = 5) {
  let currentPage = 1;
  let totalPages = null;

  const firstResponse = await fetch(
    `${url}&page=${currentPage}&per_page=${perPage}`
  );
  if (!firstResponse.ok) {
    console.log(`${url}&page=${currentPage}&per_page=${perPage}`);
    console.log(firstResponse);
    throw new Error(`Failed to fetch data: HTTP ${firstResponse.status}`);
  }
  const firstData = await firstResponse.json();
  const total = parseInt(firstResponse.headers.get('total') ?? '0', 10);
  totalPages = Math.ceil(total / perPage);
  const cv = firstData.cv;
  console.log(`Total pages: ${totalPages}`);
  console.log(`CV parameter for caching: ${cv}`);


}

/**
 * Fetch a single page of data from the API,
 * with retry logic for rate limits (HTTP 429).
 */
async function fetchPage(url, page, perPage, cv) {
  let retryCount = 0;
  // Max retry attempts
  const maxRetries = 5;
  while (retryCount <= maxRetries) {
    try {
      const response = await fetch(
        `${url}&page=${page}&per_page=${perPage}&cv=${cv}`
      );
      // Handle 429 Too Many Requests (Rate Limit)
      if (response.status === 429) {
        // Some APIs provides you the Retry-After in the header
        // Retry After indicates how long to wait before retrying.
        // Storyblok uses a fixed window counter (1 second window)
        const retryAfter = response.headers.get("Retry-After") || 1;
        console.log(
          response.headers,
          `Rate limited on page ${page}. Retrying after ${retryAfter} seconds...`
        );
        retryCount++;
        // In the case of rate limit, waiting 1 second is enough.
        // If not we will wait 2 second at the second tentative,
        // in order to progressively slow down the retry requests
        // setTimeout accept millisecond , so we have to use 1000 as multiplier
        await new Promise((resolve) =>
          setTimeout(resolve, retryAfter * 1000 * retryCount)
        );
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Failed to fetch page ${page}: HTTP ${response.status}`
        );
      }
      const data = await response.json();
      // Return the stories data of the current page
      return data.stories || [];
    } catch (error) {
      console.error(`Error fetching page ${page}: ${error.message}`);
      return []; // Return an empty array if the request fails to not break the flow
    }
  }
  console.error(`Failed to fetch page ${page} after ${maxRetries} attempts`);
  return []; // If we hit the max retry limit, return an empty array
}

/**
 * Fetch all data in parallel, processing pages in batches
 * as a generators (the reason why we use the `*`)
 */
async function* fetchAllDataInParallel(
  url,
  perPage = 25,
  numOfParallelRequests = 5
) {
  let currentPage = 1;
  let totalPages = null;

  // Fetch the first page to get:
  // - the total entries (the `total` HTTP header)
  // - the CV for caching (the `cv` atribute in the JSON response payload)
  const firstResponse = await fetch(
    `${url}&page=${currentPage}&per_page=${perPage}`
  );
  if (!firstResponse.ok) {
    console.log(`${url}&page=${currentPage}&per_page=${perPage}`);
    console.log(firstResponse);
    throw new Error(`Failed to fetch data: HTTP ${firstResponse.status}`);
  }
  console.timeLog("API", "After first response");

  const firstData = await firstResponse.json();
  const total = parseInt(firstResponse.headers.get("total"), 10) || 0;
  totalPages = Math.ceil(total / perPage);

  // Yield the stories from the first page
  for (const story of firstData.stories) {
    yield story;
  }

  const cv = firstData.cv;

  console.log(`Total pages: ${totalPages}`);
  console.log(`CV parameter for caching: ${cv}`);

  currentPage++; // Start from the second page now

  while (currentPage <= totalPages) {
    // Get the list of pages to fetch in the current batch
    const pagesToFetch = [];
    for (
      let i = 0;
      i < numOfParallelRequests && currentPage <= totalPages;
      i++
    ) {
      pagesToFetch.push(currentPage);
      currentPage++;
    }

    // Fetch the pages in parallel
    const batchRequests = pagesToFetch.map((page) =>
      fetchPage(url, page, perPage, firstData, cv)
    );

    // Wait for all requests in the batch to complete
    const batchResults = await Promise.all(batchRequests);
    console.timeLog("API", `Got ${batchResults.length} response`);
    // Yield the stories from each batch of requests
    for (let result of batchResults) {
      for (const story of result) {
        yield story;
      }
    }

    console.log(`Fetched pages: ${pagesToFetch.join(", ")}`);
  }

  //return allData;
}

console.time("API");
const apiUrl = `https://api.storyblok.com/v2/cdn/stories?token=${STORYBLOK_ACCESS_TOKEN}&version=${STORYBLOK_VERSION}`;
//const apiUrl = `http://localhost:3000?token=${STORYBLOK_ACCESS_TOKEN}&version=${STORYBLOK_VERSION}`;

const stories = fetchAllDataInParallel(apiUrl, 25, 7);

// Create an empty file (or overwrite if it exists) before appending
await writeFile("stories.json", "[", "utf8"); // Start the JSON array
let i = 0;
for await (const story of stories) {
  i++;
  console.log(story.name);
  // If it's not the first story, add a comma to separate JSON objects
  if (i > 1) {
    await appendFile("stories.json", ",", "utf8");
  }
  // Append the current story to the file
  await appendFile("stories.json", JSON.stringify(story, null, 2), "utf8");
}
// Close the JSON array in the file
await appendFile("stories.json", "]", "utf8"); // End the JSON array
console.log(`Total Stories: ${i}`);

/*
with 25 and 20
[47.93s] API
All data collected: 19902

with 25 and 10
[27.36s] API
All data collected: 19902

with 25 and 5
[116.39s] API
All data collected: 19902

with 25 and 7
[20.11s] API
All data collected: 19902
*/
