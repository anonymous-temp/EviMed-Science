package com.evimed.agent.evidence.agentevidencebased.entity.mongo;

import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 疾病数据接收类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class Disease implements SynonymHolder {
    private Integer type;
    private String word;
    private String zhWord;
    private String enWord;
    private List<String> zhSynonym = new ArrayList<>();
    private List<String> enSynonym = new ArrayList<>();
    private List<String> otherSynonym = new ArrayList<>();
    private String expandSynonym;
    private Integer status;
    @JsonIgnore
    private List<String> expandedWords;
    @JsonIgnore
    private List<String> deconsWords;
    @JsonIgnore
    private Map<String, Set<String>> synonymMap;
}
