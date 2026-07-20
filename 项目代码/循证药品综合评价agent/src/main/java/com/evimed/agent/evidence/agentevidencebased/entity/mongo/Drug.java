package com.evimed.agent.evidence.agentevidencebased.entity.mongo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

/**
 * 疾病数据接收类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class Drug implements SynonymHolder {
    private String word;
    private String zhWord;
    private String enWord;
    private List<String> zhSynonym = new ArrayList<>();
    private List<String> enSynonym = new ArrayList<>();
    private List<String> otherSynonym = new ArrayList<>();
    private String name = "";
    private String expandSynonym;
    private String dosageForm = "";
    private String commodityName = "";
    private Integer status;

    private List<String> commodityNames;
    private List<String> zhDrugNames;
    private List<String> enDrugNames;
}
