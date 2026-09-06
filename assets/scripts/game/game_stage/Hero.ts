import { _decorator, Component, Node } from 'cc';
import { Entity } from '../battle';
const { ccclass, property } = _decorator;

@ccclass('Hero')
export class Hero extends Component {
    entity:Entity

    start() {

    }

    update(deltaTime: number) {
        
    }

    bind(entity:Entity){
        this.entity = entity
    }
}


