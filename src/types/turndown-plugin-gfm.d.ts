declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';

  function gfm(service: TurndownService): void;
  function tables(service: TurndownService): void;
  function strikethrough(service: TurndownService): void;
  function taskListItems(service: TurndownService): void;

  export { gfm, tables, strikethrough, taskListItems };
}
