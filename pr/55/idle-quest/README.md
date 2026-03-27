# Idle Quest

**Live:** https://vibes.tlab.sh/idle-quest/

A browser-based incremental RPG with hero progression, zone exploration, and prestige mechanics.

## Features

- **Hero Progression** - Level up by defeating enemies, earning XP and unlocking higher zones
- **Combat System** - Manual or auto-battle with critical hits, damage scaling, and DPS tracking
- **Multi-Zone Exploration** - Progress through 6 unique zones (Forest → Cave → Ruins → Volcano → Abyss → Heaven)
- **Upgrade System** - 6 different upgrades: Attack Power, Crit Chance, Crit Damage, Gold Find, XP Boost, Auto Speed
- **Boss Battles** - Face bosses every 5 enemies with 5× HP and enhanced rewards
- **Prestige Mechanic** - Reset progress for Soul Shards that provide permanent damage bonuses (+1% per shard)
- **Resource Management** - Earn Gold for upgrades, Gems from bosses, and Soul Shards from prestiging
- **Real-time Analytics** - Live DPS tracking, gold/sec charts, and progression milestones
- **Save System** - Auto-save with export/import functionality

## Gameplay

1. **Combat** - Click "ATTACK!" or press Space to deal damage to enemies
2. **Auto-Battle** - Toggle auto-battle for hands-free progression
3. **Upgrades** - Spend gold on upgrades to increase attack, crit chance, and other stats
4. **Zone Progression** - Defeat 10 enemies to unlock the next zone
5. **Prestige** - Reach Zone 5 (Abyss) to unlock prestige, resetting progress for permanent bonuses

### Keyboard Shortcuts

| Key   | Action |
| ----- | ------ |
| Space | Attack |

## Game Mechanics

- **Critical Hits** - 5% base crit chance, 150% base crit damage (upgradable to 75% cap)
- **Boss Spawns** - Every 5th enemy is a boss with 5× HP, 3× gold, 2× XP, and gem drops
- **Zone Unlocking** - Kill 10 enemies in current zone to unlock next (up to highest zone reached)
- **Prestige Formula** - Soul Shards = floor(√(hero_level) × (highest_zone + 1))
- **Soul Bonus** - Each soul shard provides +1% damage multiplier

## Statistics Tracked

- **Total Gold Earned** - All gold collected across the entire playthrough
- **Enemies Slain** - Total enemy kill count
- **Bosses Slain** - Total boss kill count
- **Total Damage** - Cumulative damage dealt
- **Prestiges** - Number of times prestiged
- **DPS History** - Rolling 20-second damage per second chart
- **Gold Income** - Rolling 20-second gold per second chart

## Save Management

- **Auto-save** - Game saves every 30 seconds and on page close
- **Manual Save** - Click the 💾 button to save immediately
- **Export** - Download save file as JSON (⬇ button)
- **Import** - Load save file from disk (⬆ button)

## Initial prompt

The initial prompt for this vibe was not recorded. This README was reconstructed based on the implementation.
