# Add a developer's SSH public key to this worker account. Safe to run again.
# Inputs: TB_PUBLIC_KEY

key="$TB_PUBLIC_KEY"
case "$key" in
  ssh-* | ecdsa-* | sk-*) ;;
  *) fail "not an SSH public key" ;;
esac
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
file="$HOME/.ssh/authorized_keys"
touch "$file"
chmod 600 "$file"
added=false
if ! grep -qxF "$key" "$file"; then
  printf '%s\n' "$key" >>"$file"
  added=true
fi
result "{\"added\":$added}"
