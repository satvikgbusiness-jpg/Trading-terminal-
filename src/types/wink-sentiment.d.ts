declare module 'wink-sentiment' {
  interface WinkToken {
    value?: string;
    tag?: 'word' | 'punctuation' | 'emoji' | 'emoticon' | string;
    /** AFINN weight, present only for tokens the lexicon carries. */
    score?: number;
    negation?: boolean;
  }
  interface WinkResult {
    score: number;
    normalizedScore: number;
    tokenizedPhrase: WinkToken[];
  }
  function sentiment(phrase: string): WinkResult;
  export = sentiment;
}
