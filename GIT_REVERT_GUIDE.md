# Git Revert Guide - Inventory Management Changes

## Current Commit Details
- **Commit Hash**: `f204a09`
- **Commit Message**: "feat: improve inventory management logic"
- **Files Modified**: 
  - `app/utils/googleSheet.server.js`
  - `app/utils/helper.js`

## Changes Made in This Commit
- Remove date header functionality from sheets
- Fix inventory update logic to use last available subSKU
- Only remove available subSKUs during inventory decreases
- Comment out weight update process
- Improve subSKU numbering logic

---

## How to Revert If Something Goes Wrong

### Option 1: Quick Revert (Recommended)
This creates a new commit that undoes the changes without rewriting history.

```bash
# Revert the last commit
git revert HEAD

# Push the revert commit
git push origin main
```

### Option 2: Reset to Previous Commit
⚠️ **WARNING**: This rewrites git history. Only use if no one else has pulled your changes.

```bash
# Go back to the previous commit
git reset --hard HEAD~1

# Force push (only if you're sure no one else has pulled)
git push --force origin main
```

### Option 3: Revert Specific Files
If you only want to revert specific files:

```bash
# Revert only the helper.js file
git checkout HEAD~1 -- app/utils/helper.js

# Revert only the googleSheet.server.js file
git checkout HEAD~1 -- app/utils/googleSheet.server.js

# Commit the revert
git add .
git commit -m "revert: rollback inventory management changes"
git push origin main
```

---

## Verification Commands

### Check Current Status
```bash
git status
```

### View Recent Commits
```bash
git log --oneline -5
```

### View Changes in Last Commit
```bash
git show HEAD
```

### Compare with Previous Commit
```bash
git diff HEAD~1 HEAD
```

---

## Emergency Rollback Script

If you need to quickly rollback, you can run this script:

```bash
#!/bin/bash
echo "⚠️  Rolling back inventory management changes..."
echo "Current commit: $(git rev-parse HEAD)"

# Create revert commit
git revert HEAD --no-edit

# Push the revert
git push origin main

echo "✅ Rollback completed!"
echo "New commit: $(git rev-parse HEAD)"
```

Save this as `rollback.sh` and run: `chmod +x rollback.sh && ./rollback.sh`

---

## Testing After Deployment

After pushing your changes, test these scenarios:

1. **Inventory Increase**: Change inventory from 5 to 15
2. **Inventory Decrease**: Change inventory from 15 to 5
3. **Negative Inventory**: Change inventory from 15 to -5
4. **New Product Creation**: Create a new product
5. **Order Processing**: Process orders with subSKU assignment

## Monitoring Checklist

- [ ] Check app logs for errors
- [ ] Verify inventory updates work correctly
- [ ] Test subSKU assignment in orders
- [ ] Confirm sheet updates are working
- [ ] Monitor database for any issues

---

## Contact Information

If you need help with the rollback process, refer to this guide or contact the development team.

**Last Updated**: $(date)
**Commit Hash**: f204a09 