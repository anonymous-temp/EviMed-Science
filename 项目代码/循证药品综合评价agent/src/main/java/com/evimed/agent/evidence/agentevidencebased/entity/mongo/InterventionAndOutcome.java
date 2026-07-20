package com.evimed.agent.evidence.agentevidencebased.entity.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

/**
 * 参比药物及结局指标数据接收类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class InterventionAndOutcome implements SynonymHolder {
    private String word;
    private String zhWord;
    private String enWord;
    private List<String> zhSynonym = new ArrayList<>();
    private List<String> enSynonym = new ArrayList<>();
    private List<String> otherSynonym = new ArrayList<>();
    private String expandSynonym;
    private Integer status;
}
