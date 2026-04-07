import type { PageTreeItem } from '../../hooks/use-pages';

export interface TreeNode {
  page: PageTreeItem;
  children: TreeNode[];
}
