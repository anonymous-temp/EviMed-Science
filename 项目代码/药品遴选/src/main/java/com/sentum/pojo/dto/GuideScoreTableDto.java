package com.sentum.pojo.dto;

import lombok.Data;
import org.springframework.data.mongodb.core.mapping.Document;


@Data
@Document("evaluation_guide_score")
public class GuideScoreTableDto {
    private String id;

    private String title;

    private String guideId;

    private String score;


    //發佈人
    private String publishPerson;

    //來源
    private String source;

}
