import { useState, useEffect, useMemo } from 'react';
import {
  TABS,
  PRESETS,
  PRESET_LABELS,
  PRESET_DESCRIPTIONS,
  fromPreset,
  detectPreset,
  normalize,
} from '../permissions';

// Reusable preset + per-tab permission picker.
// Props:
//   value:    permissions object (will be normalized on render)
//   onChange: (nextPermissions) => void
//   disabled: optional, disables all interaction
export default function PermissionsPicker({ value, onChange, disabled = false }) {
  const norm = useMemo(() => normalize(value), [value]);

  // Local UI state: which preset button is "selected" in the toolbar.
  // Starts derived from the value, but the user may explicitly choose Custom
  // (e.g. to start editing per-tab without changing anything yet).
  const detected = detectPreset(norm);
  const [presetUI, setPresetUI] = useState(detected);

  // If the parent swaps the value to one that matches a preset, snap the UI to it.
  useEffect(() => {
    setPresetUI(detectPreset(norm));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(norm)]);

  function chooseSummary(name) {
    if (disabled) return;
    if (name === 'custom') {
      // Switching to Custom doesn't change the underlying perms — it just
      // reveals the per-tab grid for editing.
      setPresetUI('custom');
      return;
    }
    setPresetUI(name);
    onChange(fromPreset(name));
  }

  function setLevel(tabId, level) {
    if (disabled) return;
    onChange({ ...norm, [tabId]: level });
    setPresetUI('custom');
  }

  const showCustomGrid = presetUI === 'custom';

  return (
    <div className="perms-picker">
      <div className="perms-preset-row" role="radiogroup" aria-label="Access level">
        {['admin', 'editor', 'viewer', 'custom'].map((name) => (
          <button
            key={name}
            type="button"
            className={`perms-preset-btn ${presetUI === name ? 'active' : ''}`}
            onClick={() => chooseSummary(name)}
            disabled={disabled}
            role="radio"
            aria-checked={presetUI === name}
          >
            {PRESET_LABELS[name]}
          </button>
        ))}
      </div>
      <div className="perms-preset-desc muted">
        {PRESET_DESCRIPTIONS[presetUI]}
      </div>

      {showCustomGrid && (
        <div className="perms-grid">
          {TABS.map((tab) => (
            <PermsRow
              key={tab.id}
              label={tab.label}
              value={norm[tab.id]}
              options={[
                { id: 'none', label: 'None' },
                { id: 'read', label: 'View only' },
                { id: 'full', label: 'Edit' },
              ]}
              onChange={(v) => setLevel(tab.id, v)}
              disabled={disabled}
            />
          ))}
          <PermsRow
            label="Admin tab"
            sublabel="Manage users & invitations"
            value={norm.admin}
            options={[
              { id: 'none', label: 'No' },
              { id: 'full', label: 'Yes' },
            ]}
            onChange={(v) => setLevel('admin', v)}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

function PermsRow({ label, sublabel, value, options, onChange, disabled }) {
  return (
    <div className="perms-row">
      <div className="perms-row-label">
        <div>{label}</div>
        {sublabel && <div className="perms-row-sub muted">{sublabel}</div>}
      </div>
      <div className="perms-row-options" role="radiogroup" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`perms-seg-btn ${value === opt.id ? 'active' : ''}`}
            onClick={() => onChange(opt.id)}
            disabled={disabled}
            role="radio"
            aria-checked={value === opt.id}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
