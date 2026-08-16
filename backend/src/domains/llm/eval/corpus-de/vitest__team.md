<script setup>
import {
  VPTeamPage,
  VPTeamPageTitle,
  VPTeamPageSection,
  VPTeamMembers
} from '@voidzero-dev/vitepress-theme'
import { teamMembers, teamEmeritiMembers } from './.vitepress/contributors'
</script>

<VPTeamPage>
  <VPTeamPageTitle>
    <template #title>Das Team</template>
    <template #lead>
      Die Entwicklung von Vitest wird von einem internationalen Team geleitet,
      von dem sich einige Mitglieder dafür entschieden haben, unten aufgeführt zu werden.
    </template>
  </VPTeamPageTitle>
  <VPTeamMembers :members="teamMembers" />
  <VPTeamPageSection>
    <template #title>Ehemalige Teammitglieder</template>
    <template #lead>
      Hier würdigen wir einige nicht mehr aktive Teammitglieder, die in der
      Vergangenheit wertvolle Beiträge geleistet haben.
    </template>
    <template #members>
      <VPTeamMembers size="small" :members="teamEmeritiMembers" />
    </template>
  </VPTeamPageSection>
</VPTeamPage>
