/**
 * TabBar — Ghostty-style transparent titlebar.
 *
 * Single tab: a centered window title. Multiple tabs: compact tab strip.
 * (Ported from avocado/apps/ghostty.)
 */

import type { JSX } from 'react';

export interface TabBarTab {
  id: string;
  title: string;
}

export interface TabBarProps {
  tabs: TabBarTab[];
  activeTabId: string | null;
  isMac: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
  /** Extra chrome on the right (agent spawn buttons, etc.). */
  actions?: JSX.Element | null;
}

export function TabBar({
  tabs,
  activeTabId,
  isMac,
  onSelect,
  onClose,
  onNew,
  actions,
}: TabBarProps): JSX.Element {
  const single = tabs.length <= 1;
  return (
    <div className={`titlebar${isMac ? ' mac' : ''}${single ? ' single' : ''}`}>
      {single ? (
        <div className="titlebar-title">{tabs[0]?.title ?? 'chopsticks'}</div>
      ) : (
        <div className="tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab${tab.id === activeTabId ? ' active' : ''}`}
              onPointerDown={() => onSelect(tab.id)}
            >
              <span className="tab-title">{tab.title}</span>
              <button
                type="button"
                className="tab-close"
                title="Close tab"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="tab-new" title="New tab (⌘T)" onClick={onNew}>
        +
      </button>
      {actions ? <div className="titlebar-actions">{actions}</div> : null}
    </div>
  );
}

export default TabBar;
