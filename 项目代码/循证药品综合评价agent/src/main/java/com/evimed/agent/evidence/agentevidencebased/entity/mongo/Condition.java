package com.evimed.agent.evidence.agentevidencebased.entity.mongo;

import lombok.Data;
import java.util.List;

@Data
public class Condition {
    private List<Drug> drugs;
}
