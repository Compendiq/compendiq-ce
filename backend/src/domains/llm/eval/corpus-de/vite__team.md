<script setup>
import {
  VPTeamPage,
  VPTeamPageTitle,
  VPTeamPageSection,
  VPTeamMembers
} from '@voidzero-dev/vitepress-theme'
import { core, advisors, emeriti } from './_data/team'
</script>

<VPTeamPage>
  <VPTeamPageTitle>
    <template #title>Das Team</template>
    <template #lead>
      Die Entwicklung von Vite wird von einem internationalen Team geleitet, von
      dem sich einige Mitglieder entschieden haben, unten vorgestellt zu werden.
    </template>
  </VPTeamPageTitle>
  <VPTeamMembers :members="core" />
  <VPTeamPageSection>
    <template #title>Advisors</template>
    <template #lead>
      Advisors begleiten Vite von der Ökosystem-Seite aus und bringen ihre
      Erfahrung ein, um die Environment API und das Design künftiger APIs zu
      prägen.
    </template>
    <template #members>
      <VPTeamMembers size="small" :members="advisors" />
    </template>
  </VPTeamPageSection>
  <VPTeamPageSection>
    <template #title>Team Emeriti</template>
    <template #lead>
      Hier würdigen wir einige nicht mehr aktive Teammitglieder, die in der
      Vergangenheit wertvolle Beiträge geleistet haben.
    </template>
    <template #members>
      <VPTeamMembers size="small" :members="emeriti" />
    </template>
  </VPTeamPageSection>
</VPTeamPage>
