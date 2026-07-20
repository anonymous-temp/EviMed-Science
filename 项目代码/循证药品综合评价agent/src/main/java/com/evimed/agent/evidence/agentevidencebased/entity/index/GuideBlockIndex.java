package com.evimed.agent.evidence.agentevidencebased.entity.index;

import com.evimed.agent.evidence.agentevidencebased.entity.annotation.EsDocument;
import lombok.Data;

@Data
@EsDocument(index = "guide_block_index")
public class GuideBlockIndex {
    private String guideId;
    private String language;
    private String block;
    private String summary;
}
