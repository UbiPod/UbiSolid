import { join } from 'node:path';
import type { InteractionRoute } from '@solid/community-server';
import { HtmlViewEntry } from '@solid/community-server';

/**
 * An {@link HtmlViewEntry} whose template lives in this package's `templates/` folder,
 * so the path works wherever the package is installed.
 */
export class PluginHtmlViewEntry extends HtmlViewEntry {
  /**
   * @param route - The route the template is shown for.
   * @param template - File name inside this package's `templates/` folder.
   */
  public constructor(route: InteractionRoute, template: string) {
    super(route, join(__dirname, '..', 'templates', template));
  }
}
