# Runs inside the NetBox container via `manage.py shell` (see setup.sh). Idempotent.
#   - creates the admin superuser if it doesn't exist
#   - creates the tags/custom fields the dashboard reads (server/netbox/schema.json)
#   - creates a read-only "dashboard" user and, once, an API token for it
# Inputs come from the environment so no secret is written into this file.
import json
import os

from core.models import ObjectType
from extras.models import CustomField, CustomFieldChoiceSet, Tag
from users.models import ObjectPermission, Token, User

schema = json.loads(os.environ['DASHBOARD_SCHEMA'])

admin = os.environ.get('ADMIN_USER', 'admin')
if not User.objects.filter(username=admin).exists():
    User.objects.create_superuser(admin, os.environ.get('ADMIN_EMAIL', ''), os.environ['ADMIN_PASSWORD'])
    print(f'created admin user "{admin}"')

for t in schema['tags']:
    _, created = Tag.objects.get_or_create(slug=t['slug'], defaults={k: t[k] for k in ('name', 'color', 'description')})
    if created:
        print(f'created tag {t["slug"]}')

cs = schema['choiceSet']
choice_set, created = CustomFieldChoiceSet.objects.get_or_create(
    name=cs['name'], defaults={'description': cs['description'], 'extra_choices': cs['extra_choices']}
)
if created:
    print(f'created choice set "{cs["name"]}"')

types = [ObjectType.objects.get_by_natural_key(*t.split('.')) for t in schema['customFieldObjectTypes']]
for f in schema['customFields']:
    cf, created = CustomField.objects.get_or_create(
        name=f['name'],
        defaults={
            'label': f['label'],
            'type': f['type'],
            'description': f['description'],
            'group_name': 'Dashboard',
            'required': False,
            **({'choice_set': choice_set} if f['type'] == 'select' else {}),
        },
    )
    if created:
        cf.object_types.set(types)
        print(f'created custom field {f["name"]}')

# A dedicated read-only identity for the dashboard: it can view everything and change nothing.
dash, created = User.objects.get_or_create(username='dashboard')
if created:
    dash.set_unusable_password()
    dash.save()
    print('created read-only user "dashboard"')
perm, _ = ObjectPermission.objects.get_or_create(
    name='Dashboard: view everything',
    defaults={'actions': ['view'], 'description': 'Read-only access for the home lab dashboard'},
)
perm.object_types.set(ObjectType.objects.public())
dash.object_permissions.add(perm)

if os.environ.get('MAKE_DASHBOARD_TOKEN') == '1':
    Token.objects.filter(user=dash, description='home lab dashboard').delete()
    token = Token(user=dash, version=2, write_enabled=False, description='home lab dashboard')
    token.save()
    # setup.sh captures this line into secrets/dashboard.env; it's the only time the secret is shown.
    print(f'DASHBOARD_TOKEN=nbt_{token.key}.{token.token}')
