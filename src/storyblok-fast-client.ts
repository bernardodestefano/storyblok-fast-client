import { marketCodes, getFallbackMarket } from '@ilc-technology/env-utils';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { flatten } from 'flat';
import get from 'lodash.get';
import {
  checkDir,
  RELATIONS_TO_RESOLVE,
  getFilteredMarketsForBuild,
} from './utils';

export type StoryblokParams = {
  version: string;
  per_page: number;
  cv: string;
  language: string;
  fallback_lang?: string;
  page?: number;
};

export interface SbFastClientConfig {
  accessToken: string;
  version: string;
}

export class SbFastClient {
  private readonly API_URL: string;
  private datalayerPath: string;
  private marketCodes: string[];
  private version: string;

  constructor(config: SbFastClientConfig) {
    this.datalayerPath = 'datalayer/stories/';
    this.version = config?.version || Date.now().toString();
    this.marketCodes = getFilteredMarketsForBuild(marketCodes);
    this.API_URL = `https://api.storyblok.com/v2/cdn/stories?token=${config.accessToken}`;
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

  private findComponents(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    components: any,
    componentNamesToResolve: string[]
  ) {
    const flatContent: { [key: string]: string } = flatten(components);
    const flatKeys = Object.keys(flatContent).filter((key) => {
      return componentNamesToResolve.includes(flatContent[key]);
    });

    return flatKeys.map((flatKey) => {
      const componentName = flatContent[flatKey];
      const path = flatKey.split('.');
      path.pop();
      const parentFlatKey = path.join('.');
      return { [parentFlatKey]: componentName };
    });
  }

  private resolveNestedComponents(
    pathToComponents = 'content.body',
    relationsToResolve: any,
    storyData: any,
    dictionary: any,
    maxLevelOfNesting = 10
  ): any {
    const components = get(storyData, pathToComponents);

    if (!components) {
      return storyData;
    }

    const relationsMap = relationsToResolve.reduce(
      (acc: any, item: any) => {
        const [key, value] = item.split('.');
        acc[key] = value;
        return acc;
      },
      {} as { [key: string]: string }
    );

    const componentNamesToResolve = Object.keys(relationsMap);

    let foundComponents;
    let counter = 0;
    while (
      (foundComponents = this.findComponents(
        components,
        componentNamesToResolve
      )) &&
      counter <= maxLevelOfNesting
    ) {
      counter++;
      let changed = false;

      for (const foundComponent of foundComponents) {
        const pointer = Object.keys(foundComponent)[0];
        const name = foundComponent[pointer];

        const nextComponentToResolve = get(components, pointer);
        const fieldsToResolve = relationsMap[name];

        for (const key of Object.keys(nextComponentToResolve)) {
          if (fieldsToResolve.includes(key)) {
            if (Array.isArray(nextComponentToResolve[key])) {
              const uids: string[] = nextComponentToResolve[key];

              if (!(uids.length && typeof uids[0] === 'string')) {
                continue;
              }

              const fetchedTemplates = uids.map((uid) => dictionary?.[uid]);
              nextComponentToResolve[key] = fetchedTemplates;
              changed = true;
            } else if (typeof nextComponentToResolve[key] === 'string') {
              const uid: string = nextComponentToResolve[key];
              const fetchedTemplate = dictionary?.[uid] || uid;
              nextComponentToResolve[key] = fetchedTemplate;
              changed = true;
            }
          }
        }
      }

      if (!changed) {
        break;
      }
    }

    return storyData;
  }

  private resolveRelationsForStory(
    story: Record<string, any>,
    dictionary: Record<string, any>
  ): Record<string, any> {
    for (const [k, v] of Object.entries(story)) {
      if (v !== null && k !== 'uuid' && k !== '_uid') {
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
    // return stories.map((story) =>
    //   this.resolveRelationsForStory(story, dictionary)
    // );
    return stories.map((story) =>
      this.resolveNestedComponents(
        'content.body',
        RELATIONS_TO_RESOLVE,
        story,
        dictionary
      )
    );
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

        const storiesWithResolvedRelations = this.resolveRelations(
          stories,
          referencedStoriesDictionary
        );
        await writeFile(
          resolve(`${this.datalayerPath}/${mkt}/index.json`),
          JSON.stringify({ stories: storiesWithResolvedRelations }, null, 2)
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
