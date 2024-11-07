import { marketCodes, getFallbackMarket } from '@ilc-technology/env-utils';
import { readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const checkDir = async (path: string) => {
  try {
    await access(resolve(path));
  } catch (error) {
    await mkdir(resolve(path), { recursive: true });
  }
};

export type StoryblokParams = {
  version: string;
  per_page: number;
  cv: string;
  language: string;
  fallback_lang?: string;
  page?: number;
};

export async function getCacheVersion(token: string) {
  const response = await fetch(
    `https://api.storyblok.com/v2/cdn/spaces/me?token=${token}`
  );
  const data = await response.json();

  return data?.space ? data.space.version : Date.now();
}

export interface SbFastClientConfig {
  accessToken: string;
  version: string;
  marketCodes?: string[];
}

export class SbFastClient {
  private readonly API_URL: string;
  private datalayerPath: string;
  private marketCodes: string[];
  private version: string;

  constructor(config: SbFastClientConfig) {
    this.datalayerPath = 'datalayer/stories/';
    this.version = config?.version || Date.now().toString();
    this.marketCodes = this.getFilteredMarketsForBuild(marketCodes);
    this.API_URL = `https://api.storyblok.com/v2/cdn/stories?token=${config.accessToken}`;
  }

  private getFilteredMarketsForBuild(marketCodes: string[]) {
    if (process.env.MARKET)
      return marketCodes.filter((mkt) => mkt === process.env.MARKET);

    return marketCodes.filter((market) => market !== 'cn');
  }

  private async processPromisesInBulks(
    promisesFuncs: (() => Promise<any>)[],
    bulkSize = 10,
    maxRetries = 5,
    initialBackoff = 1000,
    delayMultiplier = 2
  ) {
    const results: any[] = [];

    for (let i = 0; i < promisesFuncs.length; i += bulkSize) {
      const bulk = promisesFuncs.slice(i, i + bulkSize);

      const bulkResults = await Promise.allSettled(
        bulk.map((func) =>
          this.promiseWithRetry(
            func,
            maxRetries,
            initialBackoff,
            delayMultiplier
          )
        )
      );

      bulkResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          results.push(...result.value);
        } else {
          console.error('Failed to fetch:', result.reason);
        }
      });
    }

    return results;
  }

  private async promiseWithRetry(
    promiseFunction: () => Promise<any>,
    retries = 5,
    delay = 1000,
    delayMultiplier = 2
  ) {
    let attempts = 0;

    while (attempts < retries) {
      try {
        return await promiseFunction();
      } catch (error) {
        attempts++;
        if (attempts < retries) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= delayMultiplier; // Exponential backoff
        }
      }
    }
    throw new Error('Max retries reached');
  }

  private createReferencedStoriesDictionary(
    stories: Record<string, any>[]
  ): Record<string, any> {
    return stories.reduce((acc, story) => {
      acc[story.uuid] = story;
      return acc;
    }, {});
  }

  private resolveRelationsForStory(
    story: Record<string, any>,
    dictionary: Record<string, any>
  ): Record<string, any> {
    for (const [k, v] of Object.entries(story)) {
      if (v !== null) {
        if (Array.isArray(v)) {
          story[k] = v.map((item) => {
            if (item !== null && typeof item === 'object') {
              return this.resolveRelationsForStory(item, dictionary);
            } else if (dictionary[item]) {
              return dictionary[item];
            }
            return item;
          });
        } else if (typeof v === 'object') {
          story[k] = this.resolveRelationsForStory(v, dictionary);
        } else if (dictionary[v]) {
          story[k] = dictionary[v];
          this.resolveRelationsForStory(story[k], dictionary);
        }
      }
    }
    return story;
  }

  private resolveRelations(
    stories: Record<string, any>[],
    dictionary: Record<string, any>
  ): Record<string, any>[] {
    return stories.map((story) =>
      this.resolveRelationsForStory(story, dictionary)
    );
  }

  private resolveRelationsPS(
    stories: Record<string, any>[],
    maxDepth = 20
  ): Record<string, any>[] {
    // Create a mapping from UUID to story content
    const referencedStoriesDictionary: Record<string, any> =
      this.createReferencedStoriesDictionary(stories);
    stories.forEach((story) => {
      if (story && story.uuid && story.content) {
        referencedStoriesDictionary[story.uuid] = story;
      } else {
        console.warn('Skipping invalid story:', story);
      }
    });

    // console.log('storyMap:', JSON.stringify(storyMap, null, 2));

    // Recursive function to replace UUIDs with actual stories
    function replaceUUIDs(content: any, currentDepth = 0): any {
      if (currentDepth >= maxDepth) {
        console.warn('Max depth reached');
        return content;
      }

      if (Array.isArray(content)) {
        return content.map((item) => replaceUUIDs(item, currentDepth));
      } else if (content && typeof content === 'object') {
        // If the object is a story, only resolve its 'content' property
        if (content.uuid && content.content) {
          return {
            ...content,
            content: replaceUUIDs(content.content, currentDepth),
          };
        }

        const newContent: Record<string, any> = {};
        for (const key in content) {
          const value = content[key];
          // Skip fields named '_uid' or 'uuid' but copy them over
          if (key === '_uid' || key === 'uuid') {
            newContent[key] = value;
            continue;
          }
          // Check if the value is a UUID that matches a story
          if (typeof value === 'string' && referencedStoriesDictionary[value]) {
            // Replace with the entire story object
            const story = referencedStoriesDictionary[value];
            // Recursively resolve the 'content' property of the story
            newContent[key] = {
              ...story,
              content: replaceUUIDs(story.content, currentDepth + 1),
            };
          } else {
            newContent[key] = replaceUUIDs(value, currentDepth);
          }
        }
        return newContent;
      } else if (typeof content === 'string') {
        // Replace string UUIDs with the corresponding story
        if (referencedStoriesDictionary[content]) {
          const story = referencedStoriesDictionary[content];
          return {
            ...story,
            content: replaceUUIDs(story.content, currentDepth + 1),
          };
        }
      }
      return content;
    }

    // Iterate over each story and resolve relations
    stories.forEach((story) => {
      if (story && story.content) {
        if (story.name === 'pop-up-test') {
          console.log('pop up test:', story.content);
        }
        story.content = replaceUUIDs(story.content);
      } else {
        console.warn('Skipping story with invalid content:', story);
      }
    });

    return stories;
  }

  private async fetchAdditionalStories(
    per_page: number,
    page: number,
    language: string,
    cv: string
  ) {
    const res = await fetch(
      `${this.API_URL}&per_page=${per_page}&page=${page}&language=${language}&cv=${cv}`
    );
    const data = await res.json();
    const stories = data.stories ?? [];

    return stories.length ? stories : [];
  }

  private async fetchStories({ per_page, language, cv }: StoryblokParams) {
    const start = Date.now();

    try {
      const firstResponse = await fetch(
        `${this.API_URL}&per_page=${per_page}&language=${language}&cv=${cv}`
      );
      const firstData = await firstResponse.json();
      const total = parseInt(firstResponse.headers.get('total') ?? '0') || 0;
      let totalPages = Math.ceil(total / per_page);
      let allStories = firstData.stories ?? [];

      const additionalPages = [];
      for (let page = 2; page <= totalPages; page++) {
        additionalPages.push(() =>
          this.fetchAdditionalStories(per_page, page, language, cv)
        );
      }

      const additionalStories = await this.processPromisesInBulks(
        additionalPages,
        20
      );
      const flattenedStories = additionalStories.flat();
      allStories = allStories.concat(flattenedStories);
      const end = Date.now();
      console.log(
        `[DATALAYER] Fetch market: ${language} Execution time: ${end - start}ms`
      );
      return allStories;
    } catch (error) {
      throw new Error(`Failed to fetch to fetch stories: ${error}`);
    }
  }

  async fetchMarketStories(marketCode: string, cv: string) {
    const params: StoryblokParams = {
      cv,
      language: marketCode,
      version: 'published',
      per_page: 25,
    };
    const fallbackMarket = getFallbackMarket(marketCode);
    if (fallbackMarket) {
      params.fallback_lang = fallbackMarket;
    }
    const retryAttempts = parseInt(process.env.SB_DATALAYER_RETRY ?? '5');

    for (let retries = 0; retries < retryAttempts; retries++) {
      try {
        return await this.fetchStories(params);
      } catch (err) {
        console.log(err);
        if (err === 'Too Many Requests') {
          console.log('Too many requests, waiting for 10 seconds...');
          await new Promise((resolve) => setTimeout(resolve, 10000));
        } else {
          throw new Error(`[DATALAYER] Error in fetchMarketStories: ${err}`);
        }
      }
    }
    throw new Error(
      '[DATALAYER] Error in fetchMarketStories: Maximum retry attempts exceeded'
    );
  }

  private stringify(obj: any) {
    let cache: any = [];
    let str = JSON.stringify(
      obj,
      function (key, value) {
        if (typeof value === 'object' && value !== null) {
          if (cache.indexOf(value) !== -1) {
            // Circular reference found, discard key
            console.log(`Circular reference found, discard ${key}`);
            return;
          }
          // Store value in our collection
          cache.push(value);
        }
        return value;
      },
      2
    );
    cache = null; // reset the cache
    return str;
  }

  async getAllStories() {
    const start = Date.now();
    await checkDir(this.datalayerPath);

    try {
      let totalNumberOfStories = 0;
      for (const mkt of ['it']) {
        // FIXME: this.marketCodes
        const stories = await this.fetchMarketStories(mkt, this.version);
        totalNumberOfStories = totalNumberOfStories + stories.length;
        await checkDir(`${this.datalayerPath}${mkt}`);

        const referencedStoriesDictionary: Record<string, any> =
          this.createReferencedStoriesDictionary(stories);

        // const storiesWithResolvedRelations = this.resolveRelationsPS(stories);
        const storiesWithResolvedRelations = this.resolveRelations(
          stories,
          referencedStoriesDictionary
        );
        await writeFile(
          resolve(`${this.datalayerPath}/${mkt}/index.json`),
          this.stringify({ stories: storiesWithResolvedRelations })
        );
      }

      console.log(`[DATALAYER] Number of stories: ${totalNumberOfStories}`);
    } catch (error) {
      console.error(error);
    }

    const end = Date.now();
    console.log(`[DATALAYER] Execution time: ${end - start}ms`);
  }
}
