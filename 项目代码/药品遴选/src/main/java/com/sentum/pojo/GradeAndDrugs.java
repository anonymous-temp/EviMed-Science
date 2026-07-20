package com.sentum.pojo;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;

import java.util.List;

/**
 * 药品等级与药品名称等级关系
 * @author zgm
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
@Document("evaluation_grade_drugs_0116")
public class GradeAndDrugs {
    @Id
    private String id;
    /**
     * 当前节点的词
     */
    private List<String> word;
    /**
     * 药品有效成功
     */
    private List<String> normalWord;
    /**
     * 当前节点的编码 ***.***.***.***.***
     */
    private String code;
    /**
     * 当前节点所处等级（即 . 的数量）
     */
    private Integer codeLevel;

    /**
     * 药品类型
     */
    private String type;
}
