# Commit and Push using Conventional Commits

# Ask for the type of change (feat, fix, chore, etc.)

read -p "Type of change (e.g., feat, fix, chore): " TYPE

# Ask for the scope (optional)

read -p "Scope (optional, leave blank for none): " SCOPE

# Ask for a short, descriptive message

read -p "Short description: " DESC

# Format the commit message according to Conventional Commits

if [ -z "$SCOPE" ]; then
COMMIT_MSG="$TYPE: $DESC"
else
    COMMIT_MSG="$TYPE($SCOPE): $DESC"
fi

# git add and commit

git add .
git commit -m "$COMMIT_MSG"

# Push changes

git push
