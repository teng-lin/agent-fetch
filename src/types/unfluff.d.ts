declare module 'unfluff' {
  interface UnfluffResult {
    title?: string;
    text?: string;
    author?: string[];
    description?: string;
    publisher?: string;
    date?: string;
    lang?: string;
    image?: string;
    tags?: string[];
  }

  function unfluff(html: string): UnfluffResult;
  export = unfluff;
}
